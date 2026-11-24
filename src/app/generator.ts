import { CancelledError, createProcessorWorker } from './pool'
import type {
  GenerateDoneResult,
  GenerateProgressResult,
  GenerateRequest,
  WorkerResponse,
} from '../worker/protocol'

export type GenerateProgress = Omit<GenerateProgressResult, 'type' | 'id'>
export type GenerateResult = Omit<GenerateDoneResult, 'type' | 'id'>

export class GeneratorRunner {
  private worker: Worker | null = null
  private activeId = 0
  private activeReject: ((error: Error) => void) | null = null

  run(
    req: Omit<GenerateRequest, 'type' | 'id'>,
    onProgress?: (progress: GenerateProgress) => void,
  ): Promise<GenerateResult> {
    if (this.activeReject) {
      this.cancel()
    }
    const id = ++this.activeId
    return new Promise((resolve, reject) => {
      this.activeReject = reject
      if (!this.worker) {
        this.worker = createProcessorWorker()
      }
      const worker = this.worker

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data
        if (data.id !== this.activeId) {
          if (data.type === 'generate-done') { data.preview.close() }
          return
        }
        if (data.type === 'generate-progress') {
          const { type: _type, id: _id, ...progress } = data
          onProgress?.(progress)
          return
        }
        this.activeReject = null
        if (data.type === 'generate-done') {
          const { type: _type, id: _id, ...result } = data
          resolve(result)
        } else if (data.type === 'error') {
          reject(new Error(data.message))
        }
      }

      worker.onerror = (event) => {
        event.preventDefault()
        if (id !== this.activeId) { return }
        this.worker?.terminate()
        this.worker = null
        const activeReject = this.activeReject
        this.activeReject = null
        activeReject?.(new Error(event.message || 'Generator worker crashed'))
      }

      const message: GenerateRequest = { ...req, type: 'generate', id }
      worker.postMessage(message)
    })
  }

  cancel() {
    this.activeId += 1
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    if (this.activeReject) {
      const reject = this.activeReject
      this.activeReject = null
      reject(new CancelledError())
    }
  }

  dispose() {
    this.cancel()
  }
}

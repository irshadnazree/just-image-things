import type { PreviewRequest, PreviewResult, WorkerResponse } from '../worker/protocol'
import { createProcessorWorker } from './pool'

type Pending = { req: PreviewRequest; resolve: (r: PreviewResult | null) => void; reject: (e: Error) => void }

/**
 * A dedicated worker for live previews so they never queue behind a batch.
 * Only the newest request matters: anything superseded resolves to null.
 */
export class PreviewRunner {
  private worker: Worker | null = null
  private running: Pending | null = null
  private next: Pending | null = null

  request(req: PreviewRequest): Promise<PreviewResult | null> {
    return new Promise((resolve, reject) => {
      this.next?.resolve(null)
      this.next = { req, resolve, reject }
      this.pump()
    })
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.running?.resolve(null)
    this.next?.resolve(null)
    this.running = this.next = null
  }

  private pump() {
    if (this.running || !this.next) return
    this.running = this.next
    this.next = null
    if (!this.worker) {
      this.worker = createProcessorWorker()
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.finish(e.data)
      this.worker.onerror = (e) => {
        e.preventDefault()
        this.worker?.terminate()
        this.worker = null
        this.finish({ type: 'error', id: -1, message: e.message || 'Preview worker crashed', oom: true })
      }
    }
    this.worker.postMessage(this.running.req)
  }

  private finish(data: WorkerResponse) {
    const job = this.running
    this.running = null
    if (job) {
      if (data.type === 'preview') {
        if (this.next) {
          data.before.close()
          data.after.close()
          job.resolve(null)
        } else job.resolve(data)
      } else if (data.type === 'error') job.reject(new Error(data.message))
    }
    this.pump()
  }
}

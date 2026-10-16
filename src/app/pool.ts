import type { ProcessRequest, ProcessResult, WorkerResponse } from '../worker/protocol'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

interface Job {
  msg: ProcessRequest
  resolve: (r: ProcessResult) => void
  reject: (e: Error) => void
  retries: number
}

export function createProcessorWorker(): Worker {
  return new Worker(new URL('../worker/processor.worker.ts', import.meta.url), { type: 'module' })
}

/** Default parallelism: leave a core for the UI, and don't outrun the reported device memory. */
export function autoWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  let count = Math.max(1, cores - 1)
  if (memory) count = Math.min(count, Math.max(1, Math.floor(memory * 1.5)))
  return Math.min(count, 16)
}

/**
 * A pool of image workers. When a worker runs out of memory it is replaced and the pool
 * shrinks by one, so huge batches settle at whatever the machine can sustain.
 */
export class WorkerPool {
  private idle: Worker[] = []
  private busy = new Map<Worker, Job>()
  private queue: Job[] = []
  limit: number
  onLimitChange?: (limit: number) => void

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  run(msg: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, resolve, reject, retries: 0 })
      this.pump()
    })
  }

  /** Reject everything queued or running and stop the workers mid-encode. */
  cancelAll() {
    for (const job of this.queue) job.reject(new CancelledError())
    this.queue = []
    for (const [worker, job] of this.busy) {
      worker.terminate()
      job.reject(new CancelledError())
    }
    this.busy.clear()
  }

  dispose() {
    this.cancelAll()
    for (const w of this.idle) w.terminate()
    this.idle = []
  }

  private pump() {
    while (this.queue.length && this.busy.size < this.limit) {
      const job = this.queue.shift()!
      const worker = this.idle.pop() ?? this.spawn()
      this.busy.set(worker, job)
      worker.postMessage(job.msg)
    }
  }

  private spawn(): Worker {
    const worker = createProcessorWorker()
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handleMessage(worker, e.data)
    worker.onerror = (e) => {
      e.preventDefault()
      this.handleCrash(worker, e.message || 'Worker crashed')
    }
    return worker
  }

  private handleMessage(worker: Worker, data: WorkerResponse) {
    const job = this.busy.get(worker)
    if (!job) return
    if (data.type === 'error' && data.oom) {
      this.handleCrash(worker, data.message)
      return
    }
    this.busy.delete(worker)
    if (data.type === 'done') job.resolve(data)
    else if (data.type === 'error') job.reject(new Error(data.message))
    if (this.idle.length + this.busy.size >= this.limit) worker.terminate()
    else this.idle.push(worker)
    this.pump()
  }

  /** WASM memory is unusable after an OOM, so the worker is replaced rather than reused. */
  private handleCrash(worker: Worker, message: string) {
    const job = this.busy.get(worker)
    this.busy.delete(worker)
    worker.terminate()
    if (this.limit > 1) {
      this.limit -= 1
      this.onLimitChange?.(this.limit)
    }
    if (job) {
      if (job.retries < 2) {
        job.retries += 1
        this.queue.unshift(job)
      } else {
        job.reject(new Error(`Out of memory: ${message}`))
      }
    }
    this.pump()
  }
}

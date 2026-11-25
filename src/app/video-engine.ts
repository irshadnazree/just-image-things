import {
  FRAME_EXPORT_FORMATS,
  clampTimeRange,
  computeSampleTimestamps,
  computeThumbnailSize,
} from '../lib/video-frames'
import type { ExtractOptions, FrameExportFormat, FrameNumbering, VideoMetadata } from '../lib/video-frames'
import type { ExtractedFrameChunk, VideoWorkerRequest, VideoWorkerResponse } from '../worker/video.protocol'

const SEEK_TIMEOUT_MS = 10_000

export interface ExtractProgressEvent {
  frames: Array<ExtractedFrameChunk>
  extractedCount: number
  totalEstimate: number | null
}

export interface ExtractCompleteResult {
  totalExtracted: number
  truncated: boolean
  cancelled: boolean
  ms: number
}

export interface RenderedFrameResult {
  blob: Blob
  width: number
  height: number
  timestamp: number
  ms: number
}

export interface ExportFrameItem {
  index: number
  frameNumber: number
  numbering?: FrameNumbering
  sourceTimestamp: number
}

export interface RenderFrameOptions {
  forClipboard?: boolean
  forPreview?: boolean
  signal?: AbortSignal
}

export interface ExtractCallbacks {
  onBatch: (event: ExtractProgressEvent) => void
  onEngineFallback?: (metadata: VideoMetadata) => void
}

function createDefaultVideoWorker(): Worker {
  return new Worker(new URL('../worker/video.worker.ts', import.meta.url), { type: 'module' })
}

function createAbortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode video frame'))),
      mime,
      quality,
    )
  })
}

export type WebpEncoder = (imageData: ImageData, quality: number) => Promise<ArrayBuffer>

async function defaultEncodeWebp(imageData: ImageData, quality: number): Promise<ArrayBuffer> {
  const webp = await import('@jsquash/webp')
  return webp.encode(imageData, { quality })
}

/** Encode an HTML canvas to the requested format, falling back to WASM WebP when the browser emits PNG. */
export async function encodeHtmlCanvas(
  canvas: HTMLCanvasElement,
  format: FrameExportFormat,
  quality: number,
  options?: { forClipboard?: boolean; forPreview?: boolean; encodeWebp?: WebpEncoder },
): Promise<Blob> {
  if (options?.forPreview) {
    return canvasToBlob(canvas, 'image/jpeg', 0.92)
  }
  const targetFormat: FrameExportFormat = options?.forClipboard ? 'png' : format
  const info = FRAME_EXPORT_FORMATS[targetFormat]
  const q = info.supportsQuality ? Math.min(1, Math.max(0.05, quality / 100)) : undefined
  const blob = await canvasToBlob(canvas, info.mime, q)
  if (targetFormat === 'webp' && blob.type !== 'image/webp') {
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const encodeWebp = options?.encodeWebp ?? defaultEncodeWebp
      const buffer = await encodeWebp(imageData, quality)
      return new Blob([buffer], { type: 'image/webp' })
    }
  }
  return blob
}

async function waitForPaintedFrame(video: HTMLVideoElement): Promise<void> {
  const withRvfc = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
    cancelVideoFrameCallback?: (handle: number) => void
  }
  if (typeof withRvfc.requestVideoFrameCallback === 'function') {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) { return }
        settled = true
        resolve()
      }
      const handle = withRvfc.requestVideoFrameCallback?.(finish)
      const timer = setTimeout(() => {
        if (handle !== undefined) { withRvfc.cancelVideoFrameCallback?.(handle) }
        finish()
      }, 60)
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          clearTimeout(timer)
          if (handle !== undefined) { withRvfc.cancelVideoFrameCallback?.(handle) }
          finish()
        })
      }
    })
    return
  }
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  }
}

async function seekVideo(video: HTMLVideoElement, timestamp: number): Promise<void> {
  const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.001) : 0
  const target = Math.max(0, Math.min(timestamp, maxTime))
  if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while seeking video frame.'))
    }, SEEK_TIMEOUT_MS)

    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Video seek failed.'))
    }
    const onAborted = () => {
      cleanup()
      reject(createAbortError('Video seek cancelled.'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      video.removeEventListener('emptied', onAborted)
      video.removeEventListener('abort', onAborted)
    }

    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.addEventListener('emptied', onAborted, { once: true })
    video.addEventListener('abort', onAborted, { once: true })
    video.currentTime = target
  })
  await waitForPaintedFrame(video)
}

function createHiddenVideoElement(url: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('aria-hidden', 'true')
  video.style.position = 'fixed'
  video.style.width = '1px'
  video.style.height = '1px'
  video.style.opacity = '0'
  video.style.pointerEvents = 'none'
  video.style.left = '-9999px'
  video.src = url
  document.body?.append(video)
  return video
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while loading video metadata.'))
    }, SEEK_TIMEOUT_MS)
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('This browser cannot decode this video format.'))
    }
    const onAbort = () => {
      cleanup()
      reject(createAbortError('Video load cancelled.'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      video.removeEventListener('abort', onAbort)
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.addEventListener('abort', onAbort, { once: true })
    video.load()
  })
}

function teardownVideoElement(video: HTMLVideoElement | null) {
  if (!video) { return }
  video.pause()
  video.removeAttribute('src')
  video.load()
  video.remove()
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release: (() => void) | null = null
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev.then(fn).finally(() => release?.())
  }
}

export interface FallbackVideoBackend {
  open: (file: File) => Promise<VideoMetadata>
  cancel: (id: number) => void
  extract: (
    id: number,
    options: ExtractOptions,
    onBatch: (event: ExtractProgressEvent) => void,
  ) => Promise<ExtractCompleteResult>
  renderFrame: (
    sourceTimestamp: number,
    format: FrameExportFormat,
    quality: number,
    options?: RenderFrameOptions,
  ) => Promise<RenderedFrameResult>
  exportFrames: (
    id: number,
    items: Array<ExportFrameItem>,
    format: FrameExportFormat,
    quality: number,
    onFrame: (frame: ExportFrameItem & { bytes: ArrayBuffer }) => Promise<void>,
  ) => Promise<{ count: number; cancelled: boolean; ms: number }>
  dispose: () => void
}

class HtmlVideoFallback implements FallbackVideoBackend {
  private extractVideo: HTMLVideoElement | null = null
  private renderVideo: HTMLVideoElement | null = null
  private url: string | null = null
  private meta: VideoMetadata | null = null
  private cancelledIds = new Set<number>()
  private extractMutex = new AsyncMutex()
  private renderMutex = new AsyncMutex()

  async open(file: File): Promise<VideoMetadata> {
    this.dispose()
    const url = URL.createObjectURL(file)
    const extractVideo = createHiddenVideoElement(url)
    const renderVideo = createHiddenVideoElement(url)

    try {
      await Promise.all([waitForMetadata(extractVideo), waitForMetadata(renderVideo)])
    } catch (error) {
      teardownVideoElement(extractVideo)
      teardownVideoElement(renderVideo)
      URL.revokeObjectURL(url)
      throw error
    }

    const duration = Number.isFinite(extractVideo.duration) ? extractVideo.duration : 0
    const meta: VideoMetadata = {
      fileName: file.name,
      fileSize: file.size,
      width: extractVideo.videoWidth || 1,
      height: extractVideo.videoHeight || 1,
      duration,
      firstTimestamp: 0,
      fps: null,
      estimatedFrames: duration > 0 ? Math.max(1, Math.round(duration * 30)) : null,
      codec: null,
      formatName: file.type ? file.type.replace('video/', '').toUpperCase() : null,
      hasAlpha: false,
      engine: 'video-element',
    }
    this.extractVideo = extractVideo
    this.renderVideo = renderVideo
    this.url = url
    this.meta = meta
    return meta
  }

  cancel(id: number) {
    this.cancelledIds.add(id)
  }

  extract(
    id: number,
    options: ExtractOptions,
    onBatch: (event: ExtractProgressEvent) => void,
  ): Promise<ExtractCompleteResult> {
    return this.extractMutex.run(async () => {
      const video = this.extractVideo
      const meta = this.meta
      if (!video || !meta) { throw new Error('No video loaded.') }

      const started = performance.now()
      const range = clampTimeRange(options.startTime, options.endTime, meta.duration)
      const effectiveFps =
        options.mode === 'fps'
          ? options.fps
          : options.mode === 'keyframes'
            ? 1
            : options.mode === 'every-n'
              ? Math.max(0.25, 30 / Math.max(1, options.everyN))
              : 30
      const sampled = computeSampleTimestamps(range.start, range.end, effectiveFps, options.maxFrames)
      const thumbSize = computeThumbnailSize(meta.width, meta.height, options.thumbMaxWidth)
      const canvas = document.createElement('canvas')
      canvas.width = thumbSize.width
      canvas.height = thumbSize.height
      const ctx = canvas.getContext('2d')
      if (!ctx) { throw new Error('Could not acquire 2D canvas context.') }

      let extractedCount = 0
      let cancelled = false
      let batch: Array<ExtractedFrameChunk> = []
      const stepDuration = 1 / Math.max(0.1, effectiveFps)

      try {
        for (let i = 0; i < sampled.timestamps.length; i++) {
          if (this.cancelledIds.has(id) || this.extractVideo !== video) {
            cancelled = true
            break
          }
          const ts = sampled.timestamps[i]
          await seekVideo(video, ts)
          if (this.cancelledIds.has(id) || this.extractVideo !== video) {
            cancelled = true
            break
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const blob = await canvasToBlob(canvas, 'image/jpeg', 0.78)
          const index = extractedCount
          extractedCount += 1
          batch.push({
            index,
            frameNumber: index + 1,
            numbering: 'sample',
            timestamp: ts,
            sourceTimestamp: ts,
            duration: stepDuration,
            blob,
          })
          if (batch.length >= 6 || i === sampled.timestamps.length - 1) {
            onBatch({
              frames: batch,
              extractedCount,
              totalEstimate: sampled.timestamps.length,
            })
            batch = []
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          cancelled = true
        } else {
          throw error
        }
      } finally {
        this.cancelledIds.delete(id)
      }

      return {
        totalExtracted: extractedCount,
        truncated: sampled.truncated,
        cancelled,
        ms: performance.now() - started,
      }
    })
  }

  renderFrame(
    sourceTimestamp: number,
    format: FrameExportFormat,
    quality: number,
    options?: RenderFrameOptions,
  ): Promise<RenderedFrameResult> {
    return this.renderMutex.run(async () => {
      if (options?.signal?.aborted) { throw createAbortError('Frame render cancelled.') }
      const video = this.renderVideo
      const meta = this.meta
      if (!video || !meta) { throw new Error('No video loaded.') }
      const started = performance.now()
      await seekVideo(video, sourceTimestamp)
      if (options?.signal?.aborted) { throw createAbortError('Frame render cancelled.') }
      const canvas = document.createElement('canvas')
      canvas.width = meta.width
      canvas.height = meta.height
      const ctx = canvas.getContext('2d')
      if (!ctx) { throw new Error('Could not acquire 2D canvas context.') }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await encodeHtmlCanvas(canvas, format, quality, options)
      return {
        blob,
        width: canvas.width,
        height: canvas.height,
        timestamp: sourceTimestamp,
        ms: performance.now() - started,
      }
    })
  }

  exportFrames(
    id: number,
    items: Array<ExportFrameItem>,
    format: FrameExportFormat,
    quality: number,
    onFrame: (frame: ExportFrameItem & { bytes: ArrayBuffer }) => Promise<void>,
  ): Promise<{ count: number; cancelled: boolean; ms: number }> {
    return this.renderMutex.run(async () => {
      const video = this.renderVideo
      const meta = this.meta
      if (!video || !meta) { throw new Error('No video loaded.') }
      const started = performance.now()
      const sorted = [...items].sort((a, b) => a.sourceTimestamp - b.sourceTimestamp || a.index - b.index)
      const canvas = document.createElement('canvas')
      canvas.width = meta.width
      canvas.height = meta.height
      const ctx = canvas.getContext('2d')
      if (!ctx) { throw new Error('Could not acquire 2D canvas context.') }

      let count = 0
      let cancelled = false
      try {
        for (const item of sorted) {
          if (this.cancelledIds.has(id) || this.renderVideo !== video) {
            cancelled = true
            break
          }
          await seekVideo(video, item.sourceTimestamp)
          if (this.cancelledIds.has(id) || this.renderVideo !== video) {
            cancelled = true
            break
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const blob = await encodeHtmlCanvas(canvas, format, quality)
          const bytes = await blob.arrayBuffer()
          await onFrame({ ...item, bytes })
          count += 1
        }
      } finally {
        this.cancelledIds.delete(id)
      }
      return { count, cancelled, ms: performance.now() - started }
    })
  }

  dispose() {
    teardownVideoElement(this.extractVideo)
    teardownVideoElement(this.renderVideo)
    this.extractVideo = null
    this.renderVideo = null
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
    this.meta = null
  }
}

interface PendingTask {
  onMessage: (msg: VideoWorkerResponse) => void
  onError: (err: Error & { decodeFailed?: boolean }) => void
}

/** High-performance WebCodecs video frame engine with automatic `<video>` fallback. */
export class VideoFrameEngine {
  private worker: Worker | null = null
  private workerFactory: () => Worker
  private fallbackFactory: () => FallbackVideoBackend
  private fallback: FallbackVideoBackend | null = null
  private currentFile: File | null = null
  private openGen = 0
  private extractGen = 0
  private nextId = 1
  private pending = new Map<number, PendingTask>()
  private activeOpenId: number | null = null
  private activeExtractId: number | null = null
  private activeExportId: number | null = null

  constructor(
    workerFactory: () => Worker = createDefaultVideoWorker,
    fallbackFactory: () => FallbackVideoBackend = () => new HtmlVideoFallback(),
  ) {
    this.workerFactory = workerFactory
    this.fallbackFactory = fallbackFactory
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = this.workerFactory()
      worker.onmessage = (event: MessageEvent<VideoWorkerResponse>) => {
        const msg = event.data
        const task = this.pending.get(msg.id)
        if (!task) { return }
        if (msg.type === 'error') {
          this.pending.delete(msg.id)
          const err: Error & { decodeFailed?: boolean } = new Error(msg.message)
          if (msg.decodeFailed) { err.decodeFailed = true }
          task.onError(err)
          return
        }
        task.onMessage(msg)
      }
      worker.onerror = (event) => {
        event.preventDefault()
        const err = new Error(event.message || 'Video worker crashed')
        const tasks = [...this.pending.values()]
        this.pending.clear()
        this.worker?.terminate()
        this.worker = null
        for (const task of tasks) {
          task.onError(err)
        }
      }
      this.worker = worker
    }
    return this.worker
  }

  private send(msg: VideoWorkerRequest) {
    this.ensureWorker().postMessage(msg)
  }

  async open(file: File): Promise<VideoMetadata> {
    const gen = ++this.openGen
    this.currentFile = file
    if (this.activeOpenId !== null) {
      const prevOpenId = this.activeOpenId
      this.activeOpenId = null
      const prevTask = this.pending.get(prevOpenId)
      if (prevTask) {
        this.pending.delete(prevOpenId)
        prevTask.onError(createAbortError('Video open superseded.'))
      }
    }
    this.cancelExtraction()
    this.cancelExport()
    this.fallback?.dispose()
    this.fallback = null

    const id = this.nextId++
    this.activeOpenId = id
    const workerResult = await new Promise<
      { kind: 'opened'; metadata: VideoMetadata } | { kind: 'unsupported'; reason: string }
    >((resolve, reject) => {
      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.type === 'opened') {
            this.pending.delete(id)
            if (this.activeOpenId === id) { this.activeOpenId = null }
            resolve({ kind: 'opened', metadata: msg.metadata })
          } else if (msg.type === 'unsupported') {
            this.pending.delete(id)
            if (this.activeOpenId === id) { this.activeOpenId = null }
            resolve({ kind: 'unsupported', reason: msg.reason })
          }
        },
        onError: (err) => {
          this.pending.delete(id)
          if (this.activeOpenId === id) { this.activeOpenId = null }
          reject(err)
        },
      })
      this.send({ type: 'open', id, file })
    })

    if (gen !== this.openGen) {
      throw createAbortError('Video open superseded.')
    }

    if (workerResult.kind === 'opened') {
      return workerResult.metadata
    }

    const fallback = this.fallbackFactory()
    const metadata = await fallback.open(file)
    if (gen !== this.openGen) {
      fallback.dispose()
      throw createAbortError('Video open superseded.')
    }
    this.fallback = fallback
    return metadata
  }

  extract(options: ExtractOptions, callbacks: ExtractCallbacks): Promise<ExtractCompleteResult> {
    this.cancelExtraction()
    const gen = this.openGen
    const eGen = ++this.extractGen
    const id = this.nextId++
    this.activeExtractId = id

    if (this.fallback) {
      return this.fallback
        .extract(id, options, (event) => {
          if (gen !== this.openGen || eGen !== this.extractGen) { return }
          callbacks.onBatch(event)
        })
        .finally(() => {
          if (this.activeExtractId === id) { this.activeExtractId = null }
        })
    }

    let receivedAny = false
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.type === 'frames-batch') {
            if (gen !== this.openGen || eGen !== this.extractGen) { return }
            receivedAny = true
            callbacks.onBatch({
              frames: msg.frames,
              extractedCount: msg.extractedCount,
              totalEstimate: msg.totalEstimate,
            })
          } else if (msg.type === 'extract-done') {
            this.pending.delete(id)
            if (this.activeExtractId === id) { this.activeExtractId = null }
            resolve({
              totalExtracted: msg.totalExtracted,
              truncated: msg.truncated,
              cancelled: msg.cancelled,
              ms: msg.ms,
            })
          }
        },
        onError: (err) => {
          this.pending.delete(id)
          if (this.activeExtractId === id) { this.activeExtractId = null }
          const file = this.currentFile
          if (err.decodeFailed && !receivedAny && file && gen === this.openGen && eGen === this.extractGen) {
            const fallbackStarted = performance.now()
            const fallback = this.fallbackFactory()
            let fallbackInstalled = false
            void fallback
              .open(file)
              .then((fallbackMeta) => {
                if (gen !== this.openGen) {
                  fallback.dispose()
                  reject(createAbortError('Video open superseded.'))
                  return
                }
                if (eGen !== this.extractGen) {
                  fallback.dispose()
                  resolve({
                    totalExtracted: 0,
                    truncated: false,
                    cancelled: true,
                    ms: performance.now() - fallbackStarted,
                  })
                  return
                }
                this.fallback = fallback
                fallbackInstalled = true
                callbacks.onEngineFallback?.(fallbackMeta)
                const fallbackId = this.nextId++
                this.activeExtractId = fallbackId
                return fallback
                  .extract(fallbackId, options, (event) => {
                    if (gen !== this.openGen || eGen !== this.extractGen) { return }
                    callbacks.onBatch(event)
                  })
                  .then((result) => {
                    if (this.activeExtractId === fallbackId) { this.activeExtractId = null }
                    resolve(result)
                  })
              })
              .catch((error: unknown) => {
                if (!fallbackInstalled) {
                  fallback.dispose()
                } else if (this.activeExtractId !== null) {
                  this.activeExtractId = null
                }
                if (gen !== this.openGen) {
                  reject(createAbortError('Video open superseded.'))
                  return
                }
                if (eGen !== this.extractGen) {
                  resolve({
                    totalExtracted: 0,
                    truncated: false,
                    cancelled: true,
                    ms: performance.now() - fallbackStarted,
                  })
                  return
                }
                reject(
                  fallbackInstalled
                    ? error instanceof Error
                      ? error
                      : new Error(String(error))
                    : err,
                )
              })
            return
          }
          reject(err)
        },
      })
      this.send({ type: 'extract', id, ...options })
    })
  }

  renderFrame(
    sourceTimestamp: number,
    format: FrameExportFormat,
    quality: number,
    options?: RenderFrameOptions,
  ): Promise<RenderedFrameResult> {
    if (options?.signal?.aborted) {
      return Promise.reject(createAbortError('Frame render cancelled.'))
    }
    if (this.fallback) {
      return this.fallback.renderFrame(sourceTimestamp, format, quality, options)
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) { return }
        this.pending.delete(id)
        this.worker?.postMessage({ type: 'cancel', id } satisfies VideoWorkerRequest)
        reject(createAbortError('Frame render cancelled.'))
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true })

      const cleanup = () => {
        options?.signal?.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.type === 'frame-rendered') {
            cleanup()
            this.pending.delete(id)
            resolve({
              blob: msg.blob,
              width: msg.width,
              height: msg.height,
              timestamp: msg.timestamp,
              ms: msg.ms,
            })
          } else if (msg.type === 'render-cancelled') {
            cleanup()
            this.pending.delete(id)
            reject(createAbortError('Frame render cancelled.'))
          }
        },
        onError: (err) => {
          cleanup()
          this.pending.delete(id)
          reject(err)
        },
      })
      this.send({
        type: 'render-frame',
        id,
        sourceTimestamp,
        format,
        quality,
        forClipboard: options?.forClipboard,
        forPreview: options?.forPreview,
      })
    })
  }

  exportFrames(
    items: Array<ExportFrameItem>,
    format: FrameExportFormat,
    quality: number,
    onFrame: (frame: ExportFrameItem & { bytes: ArrayBuffer }) => Promise<void>,
  ): Promise<{ count: number; cancelled: boolean; ms: number }> {
    this.cancelExport()
    const id = this.nextId++
    this.activeExportId = id

    if (this.fallback) {
      return this.fallback.exportFrames(id, items, format, quality, onFrame).finally(() => {
        if (this.activeExportId === id) { this.activeExportId = null }
      })
    }

    return new Promise((resolve, reject) => {
      let writeChain = Promise.resolve()
      let writeError: Error | null = null

      this.pending.set(id, {
        onMessage: (msg) => {
          if (msg.type === 'export-frame') {
            writeChain = writeChain.then(async () => {
              if (writeError) { return }
              try {
                await onFrame({
                  index: msg.index,
                  frameNumber: msg.frameNumber,
                  numbering: msg.numbering,
                  sourceTimestamp: msg.sourceTimestamp,
                  bytes: msg.bytes,
                })
                this.worker?.postMessage({ type: 'export-ack', id } satisfies VideoWorkerRequest)
              } catch (error) {
                writeError = error instanceof Error ? error : new Error(String(error))
                this.cancelExport()
              }
            })
          } else if (msg.type === 'export-done') {
            this.pending.delete(id)
            if (this.activeExportId === id) { this.activeExportId = null }
            void writeChain.then(() => {
              if (writeError) {
                reject(writeError)
              } else {
                resolve({ count: msg.count, cancelled: msg.cancelled, ms: msg.ms })
              }
            })
          }
        },
        onError: (err) => {
          this.pending.delete(id)
          if (this.activeExportId === id) { this.activeExportId = null }
          void writeChain.finally(() => {
            reject(writeError ?? err)
          })
        },
      })
      this.send({ type: 'export-frames', id, items, format, quality })
    })
  }

  cancelExtraction() {
    this.extractGen += 1
    if (this.activeExtractId === null) { return }
    const id = this.activeExtractId
    if (this.fallback) {
      this.fallback.cancel(id)
    } else if (this.worker) {
      this.worker.postMessage({ type: 'cancel', id } satisfies VideoWorkerRequest)
    }
  }

  cancelExport() {
    if (this.activeExportId === null) { return }
    const id = this.activeExportId
    if (this.fallback) {
      this.fallback.cancel(id)
    } else if (this.worker) {
      this.worker.postMessage({ type: 'cancel', id } satisfies VideoWorkerRequest)
    }
  }

  dispose() {
    this.openGen += 1
    this.extractGen += 1
    this.activeOpenId = null
    this.currentFile = null
    this.cancelExtraction()
    this.cancelExport()
    this.fallback?.dispose()
    this.fallback = null
    const abortErr = createAbortError('Engine disposed.')
    const tasks = [...this.pending.values()]
    this.pending.clear()
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    for (const task of tasks) {
      task.onError(abortErr)
    }
  }
}

export async function copyPngToClipboard(renderPng: () => Promise<Blob>): Promise<void> {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image copy is not supported in this browser.')
  }
  let renderError: unknown = null
  const blobPromise = renderPng().then((blob) => {
    if (blob.type !== 'image/png') {
      throw new Error(`Expected PNG image for clipboard copy, got ${blob.type || 'unknown'}.`)
    }
    return blob
  })
  void blobPromise.catch((error_: unknown) => {
    renderError = error_
  })
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
  } catch (error) {
    if (error instanceof TypeError) {
      const blob = await blobPromise
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return
    }
    throw renderError ?? error
  }
}

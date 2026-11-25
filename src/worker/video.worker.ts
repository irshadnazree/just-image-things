import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  EncodedPacketSink,
  Input,
  InputDisposedError,
} from 'mediabunny'
import type { InputVideoTrack } from 'mediabunny'
import {
  FRAME_EXPORT_FORMATS,
  clampTimeRange,
  computeSampleTimestamps,
  computeThumbnailSize,
  estimateFrameCount,
} from '../lib/video-frames'
import type { FrameExportFormat, VideoMetadata } from '../lib/video-frames'
import type { ExtractedFrameChunk, VideoWorkerRequest, VideoWorkerResponse } from './video.protocol'

const BATCH_SIZE = 12
const BATCH_FLUSH_MS = 45
const MAX_EXPORT_IN_FLIGHT = 3

let currentInput: Input | null = null
let currentTrack: InputVideoTrack | null = null
let currentMeta: VideoMetadata | null = null
let fullResSink: CanvasSink | null = null
let latestOpenId = 0
let latestPreviewRenderId = 0
let thumbMime: 'image/webp' | 'image/jpeg' = 'image/webp'
let probedThumbMime = false

const activeJobIds = new Set<number>()
const cancelledIds = new Set<number>()

interface ExportFlowState {
  inFlight: number
  waiter: (() => void) | null
}

const exportFlow = new Map<number, ExportFlowState>()

function post(message: VideoWorkerResponse, transfer?: Array<Transferable>) {
  if (transfer && transfer.length > 0) {
    self.postMessage(message, { transfer })
  } else {
    self.postMessage(message)
  }
}

function disposeInputSafely(input: Input | null) {
  if (!input) { return }
  try {
    input.dispose()
  } catch {
    void 0
  }
}

function wakeExportWaiter(id: number) {
  const flow = exportFlow.get(id)
  if (flow?.waiter) {
    const resolve = flow.waiter
    flow.waiter = null
    resolve()
  }
}

function disposeCurrent() {
  const input = currentInput
  currentInput = null
  currentTrack = null
  currentMeta = null
  fullResSink = null
  for (const id of exportFlow.keys()) {
    wakeExportWaiter(id)
  }
  disposeInputSafely(input)
}

function getFullResSink(track: InputVideoTrack, hasAlpha: boolean): CanvasSink {
  if (!fullResSink) {
    fullResSink = new CanvasSink(track, { alpha: hasAlpha, poolSize: 2 })
  }
  return fullResSink
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality?: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mime, quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))),
      mime,
      quality,
    )
  })
}

async function encodeThumbnail(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  const quality = thumbMime === 'image/webp' ? 0.72 : 0.78
  const blob = await canvasToBlob(canvas, thumbMime, quality)
  if (!probedThumbMime) {
    probedThumbMime = true
    if (thumbMime === 'image/webp' && blob.type !== 'image/webp') {
      thumbMime = 'image/jpeg'
      return canvasToBlob(canvas, 'image/jpeg', 0.78)
    }
  }
  return blob
}

function flattenForJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas === 'undefined') { return canvas }
  const opaque = new OffscreenCanvas(canvas.width, canvas.height)
  const ctx = opaque.getContext('2d')
  if (!ctx) { return canvas }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, opaque.width, opaque.height)
  ctx.drawImage(canvas, 0, 0)
  return opaque
}

async function encodeExportCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  format: FrameExportFormat,
  quality: number,
  options: { forClipboard?: boolean; forPreview?: boolean; hasAlpha: boolean },
): Promise<Blob> {
  if (options.forPreview) {
    const previewMime = options.hasAlpha ? thumbMime : 'image/jpeg'
    const source = previewMime === 'image/jpeg' && options.hasAlpha ? flattenForJpeg(canvas) : canvas
    return canvasToBlob(source, previewMime, 0.92)
  }

  const targetFormat: FrameExportFormat = options.forClipboard ? 'png' : format
  const info = FRAME_EXPORT_FORMATS[targetFormat]
  const q = info.supportsQuality ? Math.min(1, Math.max(0.05, quality / 100)) : undefined
  const source = targetFormat === 'jpeg' && options.hasAlpha ? flattenForJpeg(canvas) : canvas
  const blob = await canvasToBlob(source, info.mime, q)
  if (targetFormat === 'webp' && blob.type !== 'image/webp') {
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const webp = await import('@jsquash/webp')
      const buffer = await webp.encode(imageData, { quality })
      return new Blob([buffer], { type: 'image/webp' })
    }
  }
  return blob
}

async function handleOpen(id: number, file: File) {
  latestOpenId = id
  disposeCurrent()
  if (typeof VideoDecoder === 'undefined') {
    post({ type: 'unsupported', id, reason: 'WebCodecs VideoDecoder is not available in this browser.' })
    return
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  })

  const stale = () => id !== latestOpenId
  const abortStaleOpen = () => {
    disposeInputSafely(input)
    post({ type: 'error', id, message: 'Video open superseded.' })
  }

  try {
    const readable = await input.canRead()
    if (stale()) {
      abortStaleOpen()
      return
    }
    if (!readable) {
      disposeInputSafely(input)
      post({ type: 'unsupported', id, reason: 'Container format is not supported by the WebCodecs demuxer.' })
      return
    }

    const track = await input.getPrimaryVideoTrack()
    if (stale()) {
      abortStaleOpen()
      return
    }
    if (!track) {
      disposeInputSafely(input)
      post({ type: 'error', id, message: 'No video track found in this file.' })
      return
    }

    const decodable = await track.canDecode()
    if (stale()) {
      abortStaleOpen()
      return
    }
    if (!decodable) {
      disposeInputSafely(input)
      post({ type: 'unsupported', id, reason: 'Video codec cannot be decoded with WebCodecs in this browser.' })
      return
    }

    const [
      width,
      height,
      endTimestamp,
      firstTimestamp,
      codec,
      hasAlpha,
      format,
      stats,
    ] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.computeDuration(),
      track.getFirstTimestamp(),
      track.getCodec(),
      track.canBeTransparent(),
      input.getFormat(),
      track.computePacketStats(120).catch(() => null),
    ])

    if (stale()) {
      abortStaleOpen()
      return
    }

    const safeFirst = Number.isFinite(firstTimestamp) && firstTimestamp > 0 ? firstTimestamp : 0
    const duration = Math.max(0, (Number.isFinite(endTimestamp) ? endTimestamp : 0) - safeFirst)
    const fps =
      stats && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0
        ? Math.round(stats.averagePacketRate * 100) / 100
        : null
    const estimatedFrames =
      fps && duration > 0 ? Math.max(1, Math.round(duration * fps)) : stats?.packetCount ?? null

    const metadata: VideoMetadata = {
      fileName: file.name,
      fileSize: file.size,
      width,
      height,
      duration,
      firstTimestamp: safeFirst,
      fps,
      estimatedFrames,
      codec: codec ? codec.toUpperCase() : null,
      formatName: format.name,
      hasAlpha,
      engine: 'webcodecs',
    }

    currentInput = input
    currentTrack = track
    currentMeta = metadata
    fullResSink = null
    post({ type: 'opened', id, metadata })
  } catch (error) {
    disposeInputSafely(input)
    if (stale() || error instanceof InputDisposedError) {
      post({ type: 'error', id, message: 'Video open superseded.' })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    post({ type: 'unsupported', id, reason: message })
  }
}

async function handleExtract(req: Extract<VideoWorkerRequest, { type: 'extract' }>) {
  const track = currentTrack
  const meta = currentMeta
  if (!track || !meta) {
    post({ type: 'error', id: req.id, message: 'No video loaded.' })
    return
  }

  activeJobIds.add(req.id)
  const started = performance.now()
  const range = clampTimeRange(req.startTime, req.endTime, meta.duration)
  const absStart = meta.firstTimestamp + range.start
  const absEnd = meta.firstTimestamp + range.end
  const thumbSize = computeThumbnailSize(meta.width, meta.height, req.thumbMaxWidth)
  const sink = new CanvasSink(track, {
    width: thumbSize.width,
    height: thumbSize.height,
    fit: 'contain',
    alpha: meta.hasAlpha,
    poolSize: 4,
  })

  let totalEstimate = estimateFrameCount(meta, req.mode, req.fps, req.everyN, range.start, range.end)
  if (totalEstimate !== null && totalEstimate > req.maxFrames) {
    totalEstimate = req.maxFrames
  }

  let extractedCount = 0
  let truncated = false
  let cancelled = false
  let batch: Array<ExtractedFrameChunk> = []
  let lastFlush = performance.now()

  const flush = () => {
    if (batch.length === 0) { return }
    post({
      type: 'frames-batch',
      id: req.id,
      frames: batch,
      extractedCount,
      totalEstimate,
    })
    batch = []
    lastFlush = performance.now()
  }

  const isCancelled = () => cancelledIds.has(req.id) || currentTrack !== track

  try {
    if (req.mode === 'keyframes') {
      const packetSink = new EncodedPacketSink(track)
      const rawKeyTimestamps: Array<number> = []
      let packet = await packetSink.getKeyPacket(absStart, { metadataOnly: true })
      if (!packet || packet.timestamp < absStart - 1e-6) {
        packet = packet
          ? await packetSink.getNextKeyPacket(packet, { metadataOnly: true })
          : await packetSink.getFirstKeyPacket({ metadataOnly: true })
      }

      while (packet && packet.timestamp <= absEnd + 1e-6) {
        if (isCancelled()) {
          cancelled = true
          break
        }
        if (packet.timestamp >= absStart - 1e-6) {
          if (rawKeyTimestamps.length >= req.maxFrames) {
            truncated = true
            break
          }
          rawKeyTimestamps.push(packet.timestamp)
        }
        packet = await packetSink.getNextKeyPacket(packet, { metadataOnly: true })
      }

      const sortedKeys = rawKeyTimestamps
        .sort((a, b) => a - b)
        .filter((ts, idx, arr) => idx === 0 || Math.abs(ts - arr[idx - 1]) > 1e-5)

      if (!cancelled) {
        totalEstimate = sortedKeys.length
        let lastEmittedPts = Number.NEGATIVE_INFINITY
        const iter = sink.canvasesAtTimestamps(sortedKeys)
        try {
          for await (const wrapped of iter) {
            if (isCancelled()) {
              cancelled = true
              break
            }
            if (!wrapped || Math.abs(wrapped.timestamp - lastEmittedPts) < 1e-5) { continue }
            lastEmittedPts = wrapped.timestamp
            const blob = await encodeThumbnail(wrapped.canvas)
            const index = extractedCount
            extractedCount += 1
            const relTs = Math.max(0, wrapped.timestamp - meta.firstTimestamp)
            batch.push({
              index,
              frameNumber: index + 1,
              numbering: 'sample',
              timestamp: relTs,
              sourceTimestamp: wrapped.timestamp,
              duration: wrapped.duration,
              isKeyframe: true,
              blob,
            })
            if (batch.length >= BATCH_SIZE || performance.now() - lastFlush >= BATCH_FLUSH_MS) {
              flush()
            }
          }
        } finally {
          await iter.return()
        }
      }
    } else if (req.mode === 'fps') {
      const sampled = computeSampleTimestamps(range.start, range.end, req.fps, req.maxFrames)
      truncated = sampled.truncated
      totalEstimate = sampled.timestamps.length
      const absTimestamps = sampled.timestamps.map((t) => meta.firstTimestamp + t)
      let lastEmittedPts = Number.NEGATIVE_INFINITY
      const iter = sink.canvasesAtTimestamps(absTimestamps)
      try {
        for await (const wrapped of iter) {
          if (isCancelled()) {
            cancelled = true
            break
          }
          if (!wrapped || Math.abs(wrapped.timestamp - lastEmittedPts) < 1e-5) { continue }
          lastEmittedPts = wrapped.timestamp
          const blob = await encodeThumbnail(wrapped.canvas)
          const index = extractedCount
          extractedCount += 1
          const relTs = Math.max(0, wrapped.timestamp - meta.firstTimestamp)
          batch.push({
            index,
            frameNumber: index + 1,
            numbering: 'sample',
            timestamp: relTs,
            sourceTimestamp: wrapped.timestamp,
            duration: wrapped.duration,
            blob,
          })
          if (batch.length >= BATCH_SIZE || performance.now() - lastFlush >= BATCH_FLUSH_MS) {
            flush()
          }
        }
      } finally {
        await iter.return()
      }
    } else {
      const stride = req.mode === 'every-n' ? Math.max(1, Math.round(req.everyN)) : 1
      const fromClipStart = range.start <= 1e-4
      const endExclusive = range.end >= meta.duration - 1e-4 ? undefined : absEnd + 1e-4
      const iter = sink.canvases(absStart, endExclusive)
      let seen = 0
      try {
        for await (const wrapped of iter) {
          if (isCancelled()) {
            cancelled = true
            break
          }
          const keep = seen % stride === 0
          seen += 1
          if (!keep) { continue }
          if (extractedCount >= req.maxFrames) {
            truncated = true
            break
          }
          const blob = await encodeThumbnail(wrapped.canvas)
          const index = extractedCount
          extractedCount += 1
          const relTs = Math.max(0, wrapped.timestamp - meta.firstTimestamp)
          batch.push({
            index,
            frameNumber: fromClipStart ? seen : index + 1,
            numbering: fromClipStart ? 'frame' : 'sample',
            timestamp: relTs,
            sourceTimestamp: wrapped.timestamp,
            duration: wrapped.duration,
            blob,
          })
          if (batch.length >= BATCH_SIZE || performance.now() - lastFlush >= BATCH_FLUSH_MS) {
            flush()
          }
        }
      } finally {
        await iter.return()
      }
    }

    flush()
    post({
      type: 'extract-done',
      id: req.id,
      totalExtracted: extractedCount,
      truncated,
      cancelled,
      ms: performance.now() - started,
    })
  } catch (error) {
    if (error instanceof InputDisposedError || isCancelled()) {
      flush()
      post({
        type: 'extract-done',
        id: req.id,
        totalExtracted: extractedCount,
        truncated,
        cancelled: true,
        ms: performance.now() - started,
      })
      return
    }
    post({
      type: 'error',
      id: req.id,
      message: error instanceof Error ? error.message : String(error),
      decodeFailed: extractedCount === 0,
    })
  } finally {
    activeJobIds.delete(req.id)
    cancelledIds.delete(req.id)
  }
}

async function handleRenderFrame(req: Extract<VideoWorkerRequest, { type: 'render-frame' }>) {
  const track = currentTrack
  const meta = currentMeta
  if (!track || !meta) {
    post({ type: 'error', id: req.id, message: 'No video loaded.' })
    return
  }

  activeJobIds.add(req.id)
  if (req.forPreview) {
    latestPreviewRenderId = req.id
  }

  const isStale = () =>
    cancelledIds.has(req.id) ||
    currentTrack !== track ||
    (Boolean(req.forPreview) && req.id !== latestPreviewRenderId)

  const started = performance.now()
  try {
    if (isStale()) {
      post({ type: 'render-cancelled', id: req.id })
      return
    }
    const sink = getFullResSink(track, meta.hasAlpha)
    const wrapped = await sink.getCanvas(req.sourceTimestamp)
    if (isStale()) {
      post({ type: 'render-cancelled', id: req.id })
      return
    }
    if (!wrapped) {
      post({ type: 'error', id: req.id, message: 'Could not decode frame at requested timestamp.' })
      return
    }
    const blob = await encodeExportCanvas(wrapped.canvas, req.format, req.quality, {
      forClipboard: req.forClipboard,
      forPreview: req.forPreview,
      hasAlpha: meta.hasAlpha,
    })
    if (isStale()) {
      post({ type: 'render-cancelled', id: req.id })
      return
    }
    post({
      type: 'frame-rendered',
      id: req.id,
      blob,
      width: wrapped.canvas.width,
      height: wrapped.canvas.height,
      timestamp: Math.max(0, wrapped.timestamp - meta.firstTimestamp),
      ms: performance.now() - started,
    })
  } catch (error) {
    if (error instanceof InputDisposedError || isStale()) {
      post({ type: 'render-cancelled', id: req.id })
      return
    }
    post({
      type: 'error',
      id: req.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    activeJobIds.delete(req.id)
    cancelledIds.delete(req.id)
  }
}

async function handleExportFrames(req: Extract<VideoWorkerRequest, { type: 'export-frames' }>) {
  const track = currentTrack
  const meta = currentMeta
  if (!track || !meta) {
    post({ type: 'error', id: req.id, message: 'No video loaded.' })
    return
  }

  activeJobIds.add(req.id)
  const flow: ExportFlowState = { inFlight: 0, waiter: null }
  exportFlow.set(req.id, flow)

  const started = performance.now()
  const sorted = [...req.items].sort((a, b) => a.sourceTimestamp - b.sourceTimestamp || a.index - b.index)
  const sink = new CanvasSink(track, { alpha: meta.hasAlpha, poolSize: 2 })
  let count = 0
  let cancelled = false

  const isCancelled = () => cancelledIds.has(req.id) || currentTrack !== track

  try {
    const iter = sink.canvasesAtTimestamps(sorted.map((item) => item.sourceTimestamp))
    try {
      let cursor = 0
      for await (const wrapped of iter) {
        const item = sorted[cursor]
        cursor += 1
        if (isCancelled()) {
          cancelled = true
          break
        }
        if (!wrapped || !item) { continue }

        while (flow.inFlight >= MAX_EXPORT_IN_FLIGHT && !isCancelled()) {
          await new Promise<void>((resolve) => {
            flow.waiter = resolve
          })
        }
        if (isCancelled()) {
          cancelled = true
          break
        }

        const blob = await encodeExportCanvas(wrapped.canvas, req.format, req.quality, {
          hasAlpha: meta.hasAlpha,
        })
        const bytes = await blob.arrayBuffer()
        if (isCancelled()) {
          cancelled = true
          break
        }

        flow.inFlight += 1
        count += 1
        post(
          {
            type: 'export-frame',
            id: req.id,
            index: item.index,
            frameNumber: item.frameNumber,
            numbering: item.numbering,
            sourceTimestamp: item.sourceTimestamp,
            bytes,
          },
          [bytes],
        )
      }
    } finally {
      await iter.return()
    }
    post({
      type: 'export-done',
      id: req.id,
      count,
      cancelled,
      ms: performance.now() - started,
    })
  } catch (error) {
    if (error instanceof InputDisposedError || isCancelled()) {
      post({
        type: 'export-done',
        id: req.id,
        count,
        cancelled: true,
        ms: performance.now() - started,
      })
      return
    }
    post({
      type: 'error',
      id: req.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    exportFlow.delete(req.id)
    activeJobIds.delete(req.id)
    cancelledIds.delete(req.id)
  }
}

self.onmessage = (event: MessageEvent<VideoWorkerRequest>) => {
  const req = event.data
  if (req.type === 'cancel') {
    if (activeJobIds.has(req.id)) {
      cancelledIds.add(req.id)
      wakeExportWaiter(req.id)
    }
    return
  }
  if (req.type === 'export-ack') {
    const flow = exportFlow.get(req.id)
    if (flow) {
      flow.inFlight = Math.max(0, flow.inFlight - 1)
      if (flow.inFlight < MAX_EXPORT_IN_FLIGHT) {
        wakeExportWaiter(req.id)
      }
    }
    return
  }
  if (req.type === 'close') {
    latestOpenId += 1
    disposeCurrent()
    return
  }
  if (req.type === 'open') {
    void handleOpen(req.id, req.file)
    return
  }
  if (req.type === 'extract') {
    void handleExtract(req)
    return
  }
  if (req.type === 'render-frame') {
    void handleRenderFrame(req)
    return
  }
  if (req.type === 'export-frames') {
    void handleExportFrames(req)
  }
}

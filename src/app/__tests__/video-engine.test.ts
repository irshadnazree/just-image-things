import { describe, expect, it } from 'vitest'
import type { ExtractOptions, VideoMetadata } from '../../lib/video-frames'
import type { VideoWorkerRequest, VideoWorkerResponse } from '../../worker/video.protocol'
import { AsyncMutex, VideoFrameEngine, encodeHtmlCanvas } from '../video-engine'
import type { FallbackVideoBackend } from '../video-engine'

class MockWorker {
  sent: Array<VideoWorkerRequest> = []
  terminated = false
  onmessage: ((event: MessageEvent<VideoWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  postMessage(message: VideoWorkerRequest) {
    this.sent.push(message)
  }

  terminate() {
    this.terminated = true
  }

  emit(message: VideoWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<VideoWorkerResponse>)
  }
}

function sampleMeta(fileName: string): VideoMetadata {
  return {
    fileName,
    fileSize: 1024,
    width: 1280,
    height: 720,
    duration: 5,
    firstTimestamp: 0,
    fps: 30,
    estimatedFrames: 150,
    codec: 'AVC',
    formatName: 'MP4',
    hasAlpha: false,
    engine: 'webcodecs',
  }
}

function sampleExtractOptions(): ExtractOptions {
  return {
    mode: 'all',
    fps: 2,
    everyN: 5,
    startTime: 0,
    endTime: 5,
    thumbMaxWidth: 360,
    maxFrames: 100,
  }
}

describe('VideoFrameEngine protocol and concurrency', () => {
  it('immediately rejects a superseded open without waiting for a stale worker reply', async () => {
    const worker = new MockWorker()
    const engine = new VideoFrameEngine(() => worker as unknown as Worker)

    const p1 = engine.open(new File(['a'], 'a.mp4', { type: 'video/mp4' }))
    const open1 = worker.sent[0]
    expect(open1.type).toBe('open')

    const p2 = engine.open(new File(['b'], 'b.mp4', { type: 'video/mp4' }))
    const open2 = worker.sent[1]
    expect(open2.type).toBe('open')

    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })

    if (open2.type === 'open') {
      worker.emit({ type: 'opened', id: open2.id, metadata: sampleMeta('b.mp4') })
    }

    await expect(p2).resolves.toMatchObject({ fileName: 'b.mp4' })
  })

  it('honors cancelExtraction while automatic decoder fallback is still opening', async () => {
    const worker = new MockWorker()
    let resolveFallbackOpen: ((meta: VideoMetadata) => void) | null = null
    let fallbackDisposed = false
    let fallbackExtractCalled = false
    let onFallbackMetaCalled = false

    const fakeFallback: FallbackVideoBackend = {
      open: () =>
        new Promise<VideoMetadata>((resolve) => {
          resolveFallbackOpen = resolve
        }),
      cancel: () => {},
      extract: async () => {
        fallbackExtractCalled = true
        return { totalExtracted: 1, truncated: false, cancelled: false, ms: 1 }
      },
      renderFrame: async () => {
        throw new Error('unused')
      },
      exportFrames: async () => ({ count: 0, cancelled: false, ms: 0 }),
      dispose: () => {
        fallbackDisposed = true
      },
    }

    const engine = new VideoFrameEngine(
      () => worker as unknown as Worker,
      () => fakeFallback,
    )

    const openPromise = engine.open(new File(['v'], 'clip.mp4', { type: 'video/mp4' }))
    const openReq = worker.sent[0]
    if (openReq.type === 'open') {
      worker.emit({ type: 'opened', id: openReq.id, metadata: sampleMeta('clip.mp4') })
    }
    await openPromise

    const extractPromise = engine.extract(sampleExtractOptions(), {
      onBatch: () => {},
      onEngineFallback: () => {
        onFallbackMetaCalled = true
      },
    })

    const extractReq = worker.sent[1]
    expect(extractReq.type).toBe('extract')
    if (extractReq.type === 'extract') {
      worker.emit({ type: 'error', id: extractReq.id, message: 'Codec unsupported', decodeFailed: true })
    }

    engine.cancelExtraction()
    ;(resolveFallbackOpen as ((meta: VideoMetadata) => void) | null)?.({
      ...sampleMeta('clip.mp4'),
      engine: 'video-element',
    })

    const result = await extractPromise
    expect(result.cancelled).toBe(true)
    expect(result.totalExtracted).toBe(0)
    expect(fallbackDisposed).toBe(true)
    expect(fallbackExtractCalled).toBe(false)
    expect(onFallbackMetaCalled).toBe(false)
  })

  it('prevents an older auto-fallback from hijacking a newer extraction on the same file', async () => {
    const worker = new MockWorker()
    let resolveFallbackOpen: ((meta: VideoMetadata) => void) | null = null
    let fallbackDisposed = false
    let fallbackExtractCalled = false

    const fakeFallback: FallbackVideoBackend = {
      open: () =>
        new Promise<VideoMetadata>((resolve) => {
          resolveFallbackOpen = resolve
        }),
      cancel: () => {},
      extract: async () => {
        fallbackExtractCalled = true
        return { totalExtracted: 99, truncated: false, cancelled: false, ms: 1 }
      },
      renderFrame: async () => {
        throw new Error('unused')
      },
      exportFrames: async () => ({ count: 0, cancelled: false, ms: 0 }),
      dispose: () => {
        fallbackDisposed = true
      },
    }

    const engine = new VideoFrameEngine(
      () => worker as unknown as Worker,
      () => fakeFallback,
    )

    const openPromise = engine.open(new File(['v'], 'clip.mp4', { type: 'video/mp4' }))
    const openReq = worker.sent[0]
    if (openReq.type === 'open') {
      worker.emit({ type: 'opened', id: openReq.id, metadata: sampleMeta('clip.mp4') })
    }
    await openPromise

    const firstExtract = engine.extract(sampleExtractOptions(), { onBatch: () => {} })
    const firstReq = worker.sent[1]
    if (firstReq.type === 'extract') {
      worker.emit({ type: 'error', id: firstReq.id, message: 'Decoder error', decodeFailed: true })
    }

    const secondExtract = engine.extract({ ...sampleExtractOptions(), mode: 'fps', fps: 1 }, { onBatch: () => {} })
    const secondReq = worker.sent.find((m, idx) => idx > 1 && m.type === 'extract')
    expect(secondReq?.type).toBe('extract')

    ;(resolveFallbackOpen as ((meta: VideoMetadata) => void) | null)?.({
      ...sampleMeta('clip.mp4'),
      engine: 'video-element',
    })

    if (secondReq?.type === 'extract') {
      worker.emit({
        type: 'extract-done',
        id: secondReq.id,
        totalExtracted: 5,
        truncated: false,
        cancelled: false,
        ms: 12,
      })
    }

    await expect(firstExtract).resolves.toMatchObject({ cancelled: true, totalExtracted: 0 })
    await expect(secondExtract).resolves.toMatchObject({ cancelled: false, totalExtracted: 5 })
    expect(fallbackDisposed).toBe(true)
    expect(fallbackExtractCalled).toBe(false)
  })

  it('falls back to WASM WebP encoder when HTML canvas toBlob returns PNG for webp', async () => {
    let encodedQuality = 0
    const fakeCanvas = {
      width: 2,
      height: 2,
      toBlob: (cb: BlobCallback) => {
        cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
      },
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }) as ImageData,
      }),
    } as unknown as HTMLCanvasElement

    const blob = await encodeHtmlCanvas(fakeCanvas, 'webp', 84, {
      encodeWebp: async (_imageData, quality) => {
        encodedQuality = quality
        return new Uint8Array([82, 73, 70, 70]).buffer
      },
    })

    expect(encodedQuality).toBe(84)
    expect(blob.type).toBe('image/webp')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]))
  })

  it('sends export-ack after each onFrame resolves and waits for in-flight writes on error', async () => {
    const worker = new MockWorker()
    const engine = new VideoFrameEngine(() => worker as unknown as Worker)

    let releaseWrite: (() => void) | null = null
    let writeFinished = false
    const exportPromise = engine.exportFrames(
      [
        { index: 0, frameNumber: 1, sourceTimestamp: 0 },
        { index: 1, frameNumber: 2, sourceTimestamp: 0.5 },
      ],
      'png',
      100,
      async () => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
        writeFinished = true
      },
    )

    const req = worker.sent[0]
    expect(req.type).toBe('export-frames')
    if (req.type !== 'export-frames') { return }

    worker.emit({
      type: 'export-frame',
      id: req.id,
      index: 0,
      frameNumber: 1,
      sourceTimestamp: 0,
      bytes: new ArrayBuffer(8),
    })

    worker.emit({ type: 'error', id: req.id, message: 'Decoder reset' })

    let rejectedEarly = false
    void exportPromise.catch(() => {
      rejectedEarly = !writeFinished
    })

    await Promise.resolve()
    expect(worker.sent.some((m) => m.type === 'export-ack')).toBe(false)

    ;(releaseWrite as (() => void) | null)?.()
    await expect(exportPromise).rejects.toThrow('Decoder reset')
    expect(rejectedEarly).toBe(false)
    expect(worker.sent.some((m) => m.type === 'export-ack' && m.id === req.id)).toBe(true)
  })

  it('cancels preview renderFrame via AbortSignal and posts cancel to worker', async () => {
    const worker = new MockWorker()
    const engine = new VideoFrameEngine(() => worker as unknown as Worker)
    const controller = new AbortController()

    const renderPromise = engine.renderFrame(1.25, 'jpeg', 92, {
      forPreview: true,
      signal: controller.signal,
    })

    const req = worker.sent[0]
    expect(req.type).toBe('render-frame')
    controller.abort()

    await expect(renderPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.sent[1]).toEqual({ type: 'cancel', id: req.type === 'render-frame' ? req.id : -1 })
  })

  it('rejects all pending tasks when disposed', async () => {
    const worker = new MockWorker()
    const engine = new VideoFrameEngine(() => worker as unknown as Worker)

    const extractPromise = engine.extract(
      {
        mode: 'all',
        fps: 2,
        everyN: 5,
        startTime: 0,
        endTime: 5,
        thumbMaxWidth: 360,
        maxFrames: 100,
      },
      { onBatch: () => {} },
    )

    engine.dispose()
    expect(worker.terminated).toBe(true)
    await expect(extractPromise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('serializes concurrent operations in AsyncMutex', async () => {
    const mutex = new AsyncMutex()
    const order: Array<string> = []
    let releaseFirst: (() => void) | null = null

    const first = mutex.run(async () => {
      order.push('start-1')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('end-1')
      return 1
    })

    const second = mutex.run(async () => {
      order.push('start-2', 'end-2')
      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(['start-1'])
    ;(releaseFirst as (() => void) | null)?.()

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })
})

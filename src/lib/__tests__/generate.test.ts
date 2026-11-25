import { beforeAll, describe, expect, it } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../../worker/protocol'
import { decodeQoi } from '../codecs/qoi'
import { sniffFormat } from '../formats'
import { generatePixels, searchTargetSize } from '../generate'
import type { GeneratedPixels } from '../generate'

function countUniqueColors(pixels: GeneratedPixels): number {
  const seen = new Set<number>()
  const { data } = pixels
  for (let i = 0; i < data.length; i += 4) {
    const packed = ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) >>> 0
    seen.add(packed)
  }
  return seen.size
}

function colorEntropyScore(pixels: GeneratedPixels): number {
  return countUniqueColors(pixels) / (pixels.width * pixels.height)
}

class NodeImageData {
  readonly data: Uint8ClampedArray<ArrayBuffer>
  readonly width: number
  readonly height: number
  constructor(a: Uint8ClampedArray<ArrayBuffer> | number, b: number, c?: number) {
    if (typeof a === 'number') {
      this.width = a
      this.height = b
      this.data = new Uint8ClampedArray(new ArrayBuffer(a * b * 4))
    } else {
      this.data = a
      this.width = b
      this.height = c ?? a.length / 4 / b
    }
  }
}

let workerOnMessage: ((event: MessageEvent<WorkerRequest>) => Promise<void>) | null = null
let posted: Array<WorkerResponse> = []

async function dispatchWorker(req: WorkerRequest): Promise<Array<WorkerResponse>> {
  if (!workerOnMessage) { throw new Error('Worker harness not initialised') }
  posted = []
  await workerOnMessage({ data: req } as MessageEvent<WorkerRequest>)
  return posted
}

describe('generatePixels', () => {
  it('is deterministic for a given seed and varies across seeds', () => {
    const a = generatePixels(64, 64, 45, 12_345)
    const b = generatePixels(64, 64, 45, 12_345)
    const c = generatePixels(64, 64, 45, 54_321)

    expect(a.data.length).toBe(64 * 64 * 4)
    expect(a.data).toEqual(b.data)
    expect(a.data).not.toEqual(c.data)
  })

  it('scales colour complexity monotonically from flat (0) to noise (100)', () => {
    const c0 = countUniqueColors(generatePixels(128, 128, 0, 42))
    const c20 = countUniqueColors(generatePixels(128, 128, 20, 42))
    const c50 = countUniqueColors(generatePixels(128, 128, 50, 42))
    const c80 = countUniqueColors(generatePixels(128, 128, 80, 42))
    const c100 = countUniqueColors(generatePixels(128, 128, 100, 42))

    expect(c0).toBe(1)
    expect(c20).toBeGreaterThan(c0)
    expect(c50).toBeGreaterThan(c20)
    expect(c80).toBeGreaterThan(c50)
    expect(c100).toBeGreaterThan(c80)
  })

  it('handles 1x1 dimensions safely across complexities', () => {
    for (const complexity of [0, 20, 50, 75, 100]) {
      const img = generatePixels(1, 1, complexity, 9)
      expect(img.data.length).toBe(4)
      expect(img.data[3]).toBe(255)
    }
  })
})

describe('searchTargetSize', () => {
  it('converges via quality binary search both downward and upward', async () => {
    const down = await searchTargetSize({
      width: 32,
      height: 32,
      seed: 1,
      complexity: 45,
      targetBytes: 64_000,
      lossy: true,
      defaultQuality: 80,
      encode: async (_pixels, quality) => Math.round(10_000 + quality * 1000),
    })
    expect(down.status).toBe('matched')
    expect(Math.abs(down.size - 64_000) / 64_000).toBeLessThanOrEqual(0.1)
    expect(down.complexityAdjusted).toBe(false)

    const up = await searchTargetSize({
      width: 32,
      height: 32,
      seed: 2,
      complexity: 45,
      targetBytes: 95_000,
      lossy: true,
      defaultQuality: 50,
      encode: async (_pixels, quality) => Math.round(10_000 + quality * 1000),
    })
    expect(up.status).toBe('matched')
    expect(up.quality).toBeGreaterThan(50)
    expect(up.complexityAdjusted).toBe(false)
  })

  it('falls back to complexity search when quality saturates (lossy and lossless)', async () => {
    const higher = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 10,
      complexity: 0,
      targetBytes: 40_000,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(1000 + (0.2 + quality / 100) * (colorEntropyScore(pixels) * 90_000)),
    })
    expect(higher.status).toBe('matched')
    expect(higher.complexityAdjusted).toBe(true)
    expect(higher.complexity).toBeGreaterThan(0)

    const lower = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 11,
      complexity: 100,
      targetBytes: 5000,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(500 + (0.5 + quality / 100) * (colorEntropyScore(pixels) * 100_000)),
    })
    expect(lower.status).toBe('matched')
    expect(lower.complexityAdjusted).toBe(true)
    expect(lower.complexity).toBeLessThan(100)

    const lossless = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 12,
      complexity: 10,
      targetBytes: 25_000,
      lossy: false,
      defaultQuality: 100,
      encode: async (pixels) => Math.round(1000 + colorEntropyScore(pixels) * 80_000),
    })
    expect(lossless.status).toBe('matched')
    expect(lossless.complexityAdjusted).toBe(true)
  })

  it('reports unreachable targets (too-large and too-small) quickly', async () => {
    const tooLarge = await searchTargetSize({
      width: 16,
      height: 16,
      seed: 5,
      complexity: 50,
      targetBytes: 10_000_000,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(200 + quality * 5 + colorEntropyScore(pixels) * 500),
    })
    expect(tooLarge.status).toBe('too-large')
    expect(tooLarge.attempts).toBeLessThanOrEqual(4)

    const tooSmall = await searchTargetSize({
      width: 16,
      height: 16,
      seed: 5,
      complexity: 50,
      targetBytes: 100,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(5000 + quality * 100 + colorEntropyScore(pixels) * 20_000),
    })
    expect(tooSmall.status).toBe('too-small')
    expect(tooSmall.attempts).toBeLessThanOrEqual(4)
  })

  it('respects the maxAttempts bound', async () => {
    let calls = 0
    const result = await searchTargetSize({
      width: 32,
      height: 32,
      seed: 3,
      complexity: 50,
      targetBytes: 50_000,
      lossy: true,
      defaultQuality: 80,
      maxAttempts: 4,
      tolerance: 0.0001,
      encode: async (_pixels, quality) => {
        calls += 1
        return Math.round(1000 + quality * 1000)
      },
    })

    expect(calls).toBeLessThanOrEqual(4)
    expect(result.attempts).toBe(calls)
  })
})

describe('generation worker pipeline', () => {
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>
    if (!g.ImageData) { g.ImageData = NodeImageData }
    if (!g.createImageBitmap) {
      g.createImageBitmap = async (src: { width?: number; height?: number }) => ({
        width: src.width ?? 0,
        height: src.height ?? 0,
        close() {},
      })
    }
    g.self = globalThis
    g.postMessage = (msg: WorkerResponse) => { posted.push(msg) }
    await import('../../worker/processor.worker')
    workerOnMessage = (g.self as { onmessage: (e: MessageEvent<WorkerRequest>) => Promise<void> }).onmessage
  })

  it('synthesises and encodes a decodable image at default quality', async () => {
    const events = await dispatchWorker({
      type: 'generate',
      id: 1,
      width: 48,
      height: 32,
      complexity: 45,
      seed: 42,
      format: 'qoi',
      lossless: false,
      targetBytes: null,
    })

    const done = events.at(-1)
    if (done?.type !== 'generate-done') { throw new Error(`Expected generate-done, got ${done?.type}`) }
    expect(done.status).toBe('default')
    expect(done.width).toBe(48)
    expect(done.height).toBe(32)
    expect(done.attempts).toBe(1)

    const decoded = decodeQoi(new Uint8Array(done.bytes))
    expect(decoded.width).toBe(48)
    expect(decoded.height).toBe(32)
    expect(decoded.data).toEqual(generatePixels(48, 32, 45, 42).data)
  })

  it('runs end-to-end target-size search with a real encoder and emits progress', async () => {
    const events = await dispatchWorker({
      type: 'generate',
      id: 2,
      width: 96,
      height: 96,
      complexity: 20,
      seed: 7,
      format: 'qoi',
      lossless: false,
      targetBytes: 8000,
    })

    const progress = events.filter((e) => e.type === 'generate-progress')
    const done = events.at(-1)
    expect(progress.length).toBeGreaterThan(0)
    if (done?.type !== 'generate-done') { throw new Error(`Expected generate-done, got ${done?.type}`) }
    expect(done.status).toBe('matched')
    expect(Math.abs(done.bytes.byteLength - 8000) / 8000).toBeLessThanOrEqual(0.1)
    expect(sniffFormat(new Uint8Array(done.bytes))).toBe('qoi')
  })
})

import { describe, expect, it } from 'vitest'
import {
  MAX_DIMENSION,
  MAX_PIXELS,
  formatGeneratedFilename,
  generatePixels,
  parseTargetSize,
  searchTargetSize,
  validateDimensions,
} from '../generate'
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

describe('generatePixels', () => {
  it('is deterministic for a given seed and changes with a different seed', () => {
    const a = generatePixels(64, 64, 45, 12_345)
    const b = generatePixels(64, 64, 45, 12_345)
    const c = generatePixels(64, 64, 45, 54_321)

    expect(a.width).toBe(64)
    expect(a.height).toBe(64)
    expect(a.data.length).toBe(64 * 64 * 4)
    expect(a.data).toEqual(b.data)
    expect(a.data).not.toEqual(c.data)
  })

  it('produces a single flat opaque colour at complexity 0', () => {
    const img = generatePixels(48, 32, 0, 77)
    expect(countUniqueColors(img)).toBe(1)
    const [r, g, b, a] = img.data
    expect(a).toBe(255)
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i]).toBe(r)
      expect(img.data[i + 1]).toBe(g)
      expect(img.data[i + 2]).toBe(b)
      expect(img.data[i + 3]).toBe(255)
    }
  })

  it('produces more distinct colours as complexity increases', () => {
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
  it('converges via quality binary search when monotonic in quality', async () => {
    const targetBytes = 64_000
    const result = await searchTargetSize({
      width: 32,
      height: 32,
      seed: 1,
      complexity: 45,
      targetBytes,
      lossy: true,
      defaultQuality: 80,
      encode: async (_pixels, quality) => Math.round(10_000 + quality * 1000),
    })

    expect(result.status).toBe('matched')
    expect(Math.abs(result.size - targetBytes) / targetBytes).toBeLessThanOrEqual(0.1)
    expect(result.complexityAdjusted).toBe(false)
    expect(result.attempts).toBeLessThanOrEqual(10)
  })

  it('converges upward when target requires higher quality than default', async () => {
    const targetBytes = 95_000
    const result = await searchTargetSize({
      width: 32,
      height: 32,
      seed: 2,
      complexity: 45,
      targetBytes,
      lossy: true,
      defaultQuality: 50,
      encode: async (_pixels, quality) => Math.round(10_000 + quality * 1000),
    })

    expect(result.status).toBe('matched')
    expect(Math.abs(result.size - targetBytes) / targetBytes).toBeLessThanOrEqual(0.1)
    expect(result.quality).toBeGreaterThan(50)
    expect(result.complexityAdjusted).toBe(false)
  })

  it('adjusts complexity upward when q=100 is still too small', async () => {
    const targetBytes = 40_000
    const result = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 10,
      complexity: 0,
      targetBytes,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => {
        const entropy = colorEntropyScore(pixels)
        return Math.round(1000 + (0.2 + quality / 100) * (entropy * 90_000))
      },
    })

    expect(result.status).toBe('matched')
    expect(result.complexityAdjusted).toBe(true)
    expect(result.complexity).toBeGreaterThan(0)
    expect(Math.abs(result.size - targetBytes) / targetBytes).toBeLessThanOrEqual(0.1)
  })

  it('adjusts complexity downward when q=0 is still too large', async () => {
    const targetBytes = 5000
    const result = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 11,
      complexity: 100,
      targetBytes,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => {
        const entropy = colorEntropyScore(pixels)
        return Math.round(500 + (0.5 + quality / 100) * (entropy * 100_000))
      },
    })

    expect(result.status).toBe('matched')
    expect(result.complexityAdjusted).toBe(true)
    expect(result.complexity).toBeLessThan(100)
    expect(Math.abs(result.size - targetBytes) / targetBytes).toBeLessThanOrEqual(0.1)
  })

  it('searches complexity for lossless formats', async () => {
    const targetBytes = 25_000
    const result = await searchTargetSize({
      width: 64,
      height: 64,
      seed: 12,
      complexity: 10,
      targetBytes,
      lossy: false,
      defaultQuality: 100,
      encode: async (pixels) => Math.round(1000 + colorEntropyScore(pixels) * 80_000),
    })

    expect(result.status).toBe('matched')
    expect(result.complexityAdjusted).toBe(true)
    expect(Math.abs(result.size - targetBytes) / targetBytes).toBeLessThanOrEqual(0.1)
  })

  it('reports unreachable when target is larger than maximum achievable', async () => {
    const result = await searchTargetSize({
      width: 16,
      height: 16,
      seed: 5,
      complexity: 50,
      targetBytes: 10_000_000,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(200 + quality * 5 + colorEntropyScore(pixels) * 500),
    })

    expect(result.status).toBe('too-large')
    expect(result.size).toBeLessThan(10_000_000)
    expect(result.deltaBytes).toBeLessThan(0)
    expect(result.attempts).toBeLessThanOrEqual(4)
  })

  it('reports unreachable when target is smaller than minimum achievable', async () => {
    const result = await searchTargetSize({
      width: 16,
      height: 16,
      seed: 5,
      complexity: 50,
      targetBytes: 100,
      lossy: true,
      defaultQuality: 80,
      encode: async (pixels, quality) => Math.round(5000 + quality * 100 + colorEntropyScore(pixels) * 20_000),
    })

    expect(result.status).toBe('too-small')
    expect(result.size).toBeGreaterThan(100)
    expect(result.deltaBytes).toBeGreaterThan(0)
    expect(result.attempts).toBeLessThanOrEqual(4)
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
    expect(result.maxAttempts).toBe(4)
  })
})

describe('validation and formatting helpers', () => {
  it('validates dimensions and total pixel count', () => {
    expect(validateDimensions(1920, 1080)).toBeNull()
    expect(validateDimensions(1, 1)).toBeNull()
    expect(validateDimensions(MAX_DIMENSION, Math.floor(MAX_PIXELS / MAX_DIMENSION))).toBeNull()
    expect(validateDimensions(0, 100)).not.toBeNull()
    expect(validateDimensions(MAX_DIMENSION + 1, 100)).not.toBeNull()
    expect(validateDimensions(8000, 6000)).toMatch(/40 MP/)
  })

  it('parses optional target sizes', () => {
    expect(parseTargetSize('', 'KB')).toEqual({ bytes: null, error: null })
    expect(parseTargetSize('  ', 'MB')).toEqual({ bytes: null, error: null })
    expect(parseTargetSize('512', 'KB')).toEqual({ bytes: 512 * 1024, error: null })
    expect(parseTargetSize('1.5', 'MB')).toEqual({ bytes: Math.round(1.5 * 1024 * 1024), error: null })
    expect(parseTargetSize('0', 'KB').error).not.toBeNull()
    expect(parseTargetSize('-5', 'MB').error).not.toBeNull()
  })

  it('formats generated filenames cleanly', () => {
    expect(formatGeneratedFilename(1920, 1080, 512 * 1024, 'webp')).toBe('generated-1920x1080-512KB.webp')
    expect(formatGeneratedFilename(1920, 1080, 1_572_864, 'jpg')).toBe('generated-1920x1080-1.5MB.jpg')
    expect(formatGeneratedFilename(64, 64, 720, 'png')).toBe('generated-64x64-720B.png')
  })
})

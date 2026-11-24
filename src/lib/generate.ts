export const MIN_DIMENSION = 1
export const MAX_DIMENSION = 8192
export const MAX_PIXELS = 40_000_000
export const DEFAULT_MAX_ATTEMPTS = 14
export const DEFAULT_SIZE_TOLERANCE = 0.1

export interface GeneratedPixels {
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}

export type SizeUnit = 'KB' | 'MB'

export type EncodeSizeFn = (pixels: GeneratedPixels, quality: number) => Promise<number>

export type SearchStatus = 'matched' | 'too-small' | 'too-large' | 'closest'

export type SearchPhase = 'quality' | 'complexity'

export interface SearchProgress {
  attempt: number
  maxAttempts: number
  size: number
  quality: number
  complexity: number
  phase: SearchPhase
  isBest: boolean
}

export interface SearchOptions {
  width: number
  height: number
  seed: number
  complexity: number
  targetBytes: number
  lossy: boolean
  defaultQuality: number
  minQuality?: number
  maxQuality?: number
  tolerance?: number
  maxAttempts?: number
  encode: EncodeSizeFn
  onProgress?: (progress: SearchProgress) => void
  signal?: AbortSignal
}

export interface SearchResult {
  status: SearchStatus
  size: number
  targetBytes: number
  deltaBytes: number
  deltaRatio: number
  quality: number
  complexity: number
  complexityAdjusted: boolean
  attempts: number
  maxAttempts: number
}

export const COMPLEXITY_LEVELS = [
  { label: 'Flat', value: 0 },
  { label: 'Gradient', value: 20 },
  { label: 'Shapes', value: 45 },
  { label: 'Detailed', value: 70 },
  { label: 'Noise', value: 100 },
] as const

export const DIMENSION_PRESETS = [
  { label: '512×512', width: 512, height: 512 },
  { label: '1280×720', width: 1280, height: 720 },
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '3840×2160', width: 3840, height: 2160 },
] as const

const SIN_LUT = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  SIN_LUT[i] = Math.sin((i / 256) * Math.PI * 2)
}

export function createPrng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 999_999_999) + 1
}

export function complexityLabel(complexity: number): string {
  if (complexity <= 0) { return 'Flat' }
  if (complexity <= 25) { return 'Gradient' }
  if (complexity <= 55) { return 'Shapes' }
  if (complexity <= 80) { return 'Detailed' }
  return 'Noise'
}

export function validateDimensions(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return 'Width and height must be whole numbers.'
  }
  if (width < MIN_DIMENSION || width > MAX_DIMENSION || height < MIN_DIMENSION || height > MAX_DIMENSION) {
    return `Width and height must each be between ${MIN_DIMENSION} and ${MAX_DIMENSION.toLocaleString()} px.`
  }
  const pixels = width * height
  if (pixels > MAX_PIXELS) {
    const mp = (pixels / 1_000_000).toFixed(1)
    const maxMp = Math.round(MAX_PIXELS / 1_000_000)
    return `Total size is ${mp} MP, which exceeds the ${maxMp} MP limit.`
  }
  return null
}

export function parseTargetSize(raw: string, unit: SizeUnit): { bytes: number | null; error: string | null } {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { bytes: null, error: null }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) {
    return { bytes: null, error: 'Target size must be a positive number.' }
  }
  const multiplier = unit === 'MB' ? 1024 * 1024 : 1024
  const bytes = Math.round(value * multiplier)
  if (bytes < 1) {
    return { bytes: null, error: 'Target size is too small.' }
  }
  return { bytes, error: null }
}

export function formatGeneratedFilename(width: number, height: number, bytes: number, ext: string): string {
  let sizeToken: string
  if (bytes < 1024) {
    sizeToken = `${bytes}B`
  } else if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    sizeToken = `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  } else {
    const mb = bytes / (1024 * 1024)
    sizeToken = `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
  }
  return `generated-${width}x${height}-${sizeToken}.${ext}`
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) {
    r = c
    g = x
  } else if (hue < 120) {
    r = x
    g = c
  } else if (hue < 180) {
    g = c
    b = x
  } else if (hue < 240) {
    g = x
    b = c
  } else if (hue < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function fillFlat(data: Uint8ClampedArray<ArrayBuffer>, r: number, g: number, b: number) {
  const view = new Uint32Array(data.buffer)
  const packed = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
  view.fill(packed)
}

function fillFullNoise(data: Uint8ClampedArray<ArrayBuffer>, seed: number) {
  let state = (seed ^ 0xa5_a5_a5_a5) >>> 0
  if (state === 0) { state = 0x6d_2b_79_f5 }
  const len = data.length
  for (let i = 0; i < len; i += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    data[i] = state & 255
    data[i + 1] = (state >>> 8) & 255
    data[i + 2] = (state >>> 16) & 255
    data[i + 3] = 255
  }
}

function drawGradient(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  c0: [number, number, number],
  c1: [number, number, number],
  angle: number,
  strength: number,
) {
  const dr = (c1[0] - c0[0]) * strength
  const dg = (c1[1] - c0[1]) * strength
  const db = (c1[2] - c0[2]) * strength
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const invW = width > 1 ? 1 / (width - 1) : 0
  const invH = height > 1 ? 1 / (height - 1) : 0
  const scale = 1 / (Math.abs(cos) + Math.abs(sin))
  const r0 = c0[0]
  const g0 = c0[1]
  const b0 = c0[2]

  let offset = 0
  for (let y = 0; y < height; y++) {
    const ny = (y * invH - 0.5) * sin
    for (let x = 0; x < width; x++) {
      const proj = ((x * invW - 0.5) * cos + ny) * scale + 0.5
      const t = proj < 0 ? 0 : proj > 1 ? 1 : proj
      data[offset] = (r0 + dr * t + 0.5) | 0
      data[offset + 1] = (g0 + dg * t + 0.5) | 0
      data[offset + 2] = (b0 + db * t + 0.5) | 0
      data[offset + 3] = 255
      offset += 4
    }
  }
}

function drawShapes(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  baseHue: number,
  count: number,
  seed: number,
) {
  const rng = createPrng((seed ^ 0x9e_37_79_b9) >>> 0)
  const minSide = Math.min(width, height)
  for (let s = 0; s < count; s++) {
    const isCircle = rng() < 0.55
    const hue = (baseHue + 35 + rng() * 290) % 360
    const sat = 0.55 + rng() * 0.35
    const light = 0.3 + rng() * 0.45
    const [sr, sg, sb] = hslToRgb(hue, sat, light)
    const alpha = 0.45 + rng() * 0.4
    const invAlpha = 1 - alpha
    const ar = sr * alpha
    const ag = sg * alpha
    const ab = sb * alpha

    if (isCircle) {
      const cx = rng() * width
      const cy = rng() * height
      const radius = Math.max(1, (0.03 + rng() * 0.16) * minSide)
      const r2 = radius * radius
      const x0 = Math.max(0, Math.floor(cx - radius))
      const x1 = Math.min(width - 1, Math.ceil(cx + radius))
      const y0 = Math.max(0, Math.floor(cy - radius))
      const y1 = Math.min(height - 1, Math.ceil(cy + radius))
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy
        const dy2 = dy * dy
        const row = y * width
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx
          if (dx * dx + dy2 <= r2) {
            const idx = (row + x) * 4
            data[idx] = (data[idx] * invAlpha + ar + 0.5) | 0
            data[idx + 1] = (data[idx + 1] * invAlpha + ag + 0.5) | 0
            data[idx + 2] = (data[idx + 2] * invAlpha + ab + 0.5) | 0
          }
        }
      }
    } else {
      const rw = Math.max(1, (0.04 + rng() * 0.22) * width)
      const rh = Math.max(1, (0.04 + rng() * 0.22) * height)
      const rx = rng() * Math.max(1, width - rw * 0.5)
      const ry = rng() * Math.max(1, height - rh * 0.5)
      const x0 = Math.max(0, Math.floor(rx))
      const x1 = Math.min(width - 1, Math.floor(rx + rw))
      const y0 = Math.max(0, Math.floor(ry))
      const y1 = Math.min(height - 1, Math.floor(ry + rh))
      for (let y = y0; y <= y1; y++) {
        const row = y * width
        for (let x = x0; x <= x1; x++) {
          const idx = (row + x) * 4
          data[idx] = (data[idx] * invAlpha + ar + 0.5) | 0
          data[idx + 1] = (data[idx + 1] * invAlpha + ag + 0.5) | 0
          data[idx + 2] = (data[idx + 2] * invAlpha + ab + 0.5) | 0
        }
      }
    }
  }
}

function applyDetail(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  detailT: number,
  seed: number,
) {
  const rng = createPrng((seed ^ 0x51_7c_c1_b7) >>> 0)
  const fx1 = 3 + Math.floor(rng() * 11)
  const fy1 = 3 + Math.floor(rng() * 11)
  const fx2 = 13 + Math.floor(rng() * 19)
  const fy2 = 13 + Math.floor(rng() * 19)
  const pR = Math.floor(rng() * 256)
  const pG = Math.floor(rng() * 256)
  const pB = Math.floor(rng() * 256)
  const waveAmp = (0.35 + 0.65 * detailT) * 48
  const grainAmp = detailT * 52
  const seedHash = (seed ^ 0x27_d4_eb_2d) >>> 0
  const maskLimit = Math.round(detailT * 65_536)

  let offset = 0
  for (let y = 0; y < height; y++) {
    const by = y >> 1
    const ty = y >> 2
    const yWave1 = y * fy1
    const yWave2 = y * fy2
    for (let x = 0; x < width; x++) {
      const tx = x >> 2
      let th = Math.imul(tx * 159_733_467 + ty * 381_201_581 + seedHash, 747_796_405)
      th = (th ^ (th >>> 15)) >>> 0
      if ((th & 0xff_ff) < maskLimit) {
        const bx = x >> 1
        let h = Math.imul(bx * 374_761_393 + by * 668_265_263 + seedHash, 1_274_126_177)
        h = (h ^ (h >>> 15)) >>> 0
        const gR = (((h & 255) / 127.5) - 1) * grainAmp
        const gG = ((((h >>> 8) & 255) / 127.5) - 1) * grainAmp
        const gB = ((((h >>> 16) & 255) / 127.5) - 1) * grainAmp

        const w1 = SIN_LUT[(x * fx1 + yWave1 + pR) & 255]
        const w2 = SIN_LUT[(x * fx2 - yWave2 + pG) & 255]
        const w3 = SIN_LUT[((x + y) * fx1 + pB) & 255]

        data[offset] = clampByte(Math.round(data[offset] + (w1 + w2 * 0.5) * waveAmp + gR))
        data[offset + 1] = clampByte(Math.round(data[offset + 1] + (w2 + w3 * 0.5) * waveAmp + gG))
        data[offset + 2] = clampByte(Math.round(data[offset + 2] + (w3 - w1 * 0.5) * waveAmp + gB))
      }
      offset += 4
    }
  }
}

function applyNoise(data: Uint8ClampedArray<ArrayBuffer>, noiseT: number, seed: number) {
  let state = (seed ^ 0xa5_a5_a5_a5) >>> 0
  if (state === 0) { state = 0x6d_2b_79_f5 }
  const coverage = Math.round(noiseT * noiseT * 65_536)
  const blend = 0.35 + 0.65 * noiseT
  const invBlend = 1 - blend
  const len = data.length
  for (let i = 0; i < len; i += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const gate = (state >>> 16) & 0xff_ff
    if (gate < coverage) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      data[i] = (data[i] * invBlend + (state & 255) * blend + 0.5) | 0
      data[i + 1] = (data[i + 1] * invBlend + ((state >>> 8) & 255) * blend + 0.5) | 0
      data[i + 2] = (data[i + 2] * invBlend + ((state >>> 16) & 255) * blend + 0.5) | 0
    }
  }
}

export function generatePixels(width: number, height: number, complexity: number, seed: number): GeneratedPixels {
  const c = Math.max(0, Math.min(100, complexity))
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4))

  if (c >= 100) {
    fillFullNoise(data, seed)
    return { width, height, data }
  }

  const rng = createPrng(seed)
  const h0 = rng() * 360
  const s0 = 0.55 + rng() * 0.3
  const l0 = 0.42 + rng() * 0.2
  const c0 = hslToRgb(h0, s0, l0)

  if (c <= 0) {
    fillFlat(data, c0[0], c0[1], c0[2])
    return { width, height, data }
  }

  const h1 = (h0 + 110 + rng() * 140) % 360
  const s1 = 0.55 + rng() * 0.3
  const l1 = 0.35 + rng() * 0.3
  const c1 = hslToRgb(h1, s1, l1)
  const angle = rng() * Math.PI * 2

  drawGradient(data, width, height, c0, c1, angle, Math.min(1, c / 25))

  if (c > 25) {
    const shapeT = Math.min(1, (c - 25) / 30)
    const shapeCount = Math.max(1, Math.round(shapeT * 72))
    drawShapes(data, width, height, h0, shapeCount, seed)
  }

  if (c > 55) {
    const detailT = Math.min(1, (c - 55) / 25)
    applyDetail(data, width, height, detailT, seed)
  }

  if (c > 75) {
    const noiseT = (c - 75) / 25
    applyNoise(data, noiseT, seed)
  }

  return { width, height, data }
}

function abortError(): Error {
  const error = new Error('Cancelled')
  error.name = 'AbortError'
  return error
}

export async function searchTargetSize(options: SearchOptions): Promise<SearchResult> {
  const {
    width,
    height,
    seed,
    targetBytes,
    lossy,
    encode,
    onProgress,
    signal,
  } = options
  const initialComplexity = Math.max(0, Math.min(100, options.complexity))
  const tolerance = options.tolerance ?? DEFAULT_SIZE_TOLERANCE
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const minQuality = options.minQuality ?? 0
  const maxQuality = options.maxQuality ?? 100
  const defaultQuality = Math.max(minQuality, Math.min(maxQuality, Math.round(options.defaultQuality)))

  const isWithin = (size: number) => Math.abs(size - targetBytes) <= targetBytes * tolerance

  let attempts = 0
  let best: { size: number; quality: number; complexity: number } | null = null
  let proved: 'too-small' | 'too-large' | null = null

  const evaluate = async (
    pixels: GeneratedPixels,
    complexity: number,
    quality: number,
    phase: SearchPhase,
  ): Promise<number> => {
    if (signal?.aborted) { throw abortError() }
    attempts += 1
    const size = await encode(pixels, quality)
    if (signal?.aborted) { throw abortError() }
    const isBest = best === null || Math.abs(size - targetBytes) < Math.abs(best.size - targetBytes)
    if (isBest) {
      best = { size, quality, complexity }
    }
    onProgress?.({ attempt: attempts, maxAttempts, size, quality, complexity, phase, isBest })
    return size
  }

  const searchComplexityRange = async (
    loStart: number,
    hiStart: number,
    fixedQuality: number,
  ): Promise<boolean> => {
    let lo = loStart
    let hi = hiStart
    while (attempts < maxAttempts && hi - lo >= 0.05) {
      const mid = (lo + hi) / 2
      const pixels = generatePixels(width, height, mid, seed)
      const size = await evaluate(pixels, mid, fixedQuality, 'complexity')
      if (isWithin(size)) { return true }
      if (size < targetBytes) {
        lo = mid
      } else {
        hi = mid
      }
    }
    return false
  }

  const initialPixels = generatePixels(width, height, initialComplexity, seed)
  const startQuality = lossy ? defaultQuality : maxQuality
  const initialSize = await evaluate(initialPixels, initialComplexity, startQuality, lossy ? 'quality' : 'complexity')

  if (!isWithin(initialSize) && attempts < maxAttempts) {
    if (lossy) {
      if (initialSize < targetBytes) {
        let qualityTooSmall = startQuality >= maxQuality
        if (!qualityTooSmall) {
          const maxSize = await evaluate(initialPixels, initialComplexity, maxQuality, 'quality')
          if (!isWithin(maxSize)) {
            if (maxSize > targetBytes) {
              let lo = startQuality
              let hi = maxQuality
              while (attempts < maxAttempts && hi - lo > 1) {
                const mid = Math.floor((lo + hi) / 2)
                const size = await evaluate(initialPixels, initialComplexity, mid, 'quality')
                if (isWithin(size)) { break }
                if (size < targetBytes) {
                  lo = mid
                } else {
                  hi = mid
                }
              }
            } else {
              qualityTooSmall = true
            }
          }
        }
        if (qualityTooSmall && attempts < maxAttempts) {
          if (initialComplexity >= 100) {
            proved = 'too-large'
          } else {
            const maxPixels = generatePixels(width, height, 100, seed)
            const highSize = await evaluate(maxPixels, 100, maxQuality, 'complexity')
            if (!isWithin(highSize)) {
              if (highSize < targetBytes) {
                proved = 'too-large'
              } else {
                await searchComplexityRange(initialComplexity, 100, maxQuality)
              }
            }
          }
        }
      } else {
        let qualityTooLarge = startQuality <= minQuality
        if (!qualityTooLarge) {
          const minSize = await evaluate(initialPixels, initialComplexity, minQuality, 'quality')
          if (!isWithin(minSize)) {
            if (minSize < targetBytes) {
              let lo = minQuality
              let hi = startQuality
              while (attempts < maxAttempts && hi - lo > 1) {
                const mid = Math.floor((lo + hi) / 2)
                const size = await evaluate(initialPixels, initialComplexity, mid, 'quality')
                if (isWithin(size)) { break }
                if (size < targetBytes) {
                  lo = mid
                } else {
                  hi = mid
                }
              }
            } else {
              qualityTooLarge = true
            }
          }
        }
        if (qualityTooLarge && attempts < maxAttempts) {
          if (initialComplexity <= 0) {
            proved = 'too-small'
          } else {
            const minPixels = generatePixels(width, height, 0, seed)
            const lowSize = await evaluate(minPixels, 0, minQuality, 'complexity')
            if (!isWithin(lowSize)) {
              if (lowSize > targetBytes) {
                proved = 'too-small'
              } else {
                await searchComplexityRange(0, initialComplexity, minQuality)
              }
            }
          }
        }
      }
    } else if (initialSize < targetBytes) {
      if (initialComplexity >= 100) {
        proved = 'too-large'
      } else {
        const maxPixels = generatePixels(width, height, 100, seed)
        const highSize = await evaluate(maxPixels, 100, startQuality, 'complexity')
        if (!isWithin(highSize)) {
          if (highSize < targetBytes) {
            proved = 'too-large'
          } else {
            await searchComplexityRange(initialComplexity, 100, startQuality)
          }
        }
      }
    } else if (initialComplexity <= 0) {
      proved = 'too-small'
    } else {
      const minPixels = generatePixels(width, height, 0, seed)
      const lowSize = await evaluate(minPixels, 0, startQuality, 'complexity')
      if (!isWithin(lowSize)) {
        if (lowSize > targetBytes) {
          proved = 'too-small'
        } else {
          await searchComplexityRange(0, initialComplexity, startQuality)
        }
      }
    }
  }

  const winner = best ?? { size: initialSize, quality: startQuality, complexity: initialComplexity }
  const status: SearchStatus = isWithin(winner.size) ? 'matched' : (proved ?? 'closest')
  const deltaBytes = winner.size - targetBytes

  return {
    status,
    size: winner.size,
    targetBytes,
    deltaBytes,
    deltaRatio: targetBytes > 0 ? deltaBytes / targetBytes : 0,
    quality: winner.quality,
    complexity: Math.round(winner.complexity * 10) / 10,
    complexityAdjusted: Math.abs(winner.complexity - initialComplexity) > 0.05,
    attempts,
    maxAttempts,
  }
}

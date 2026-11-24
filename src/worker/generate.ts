import { FORMAT_BY_ID } from '../lib/formats'
import type { EncodableFormat, LossyFormat } from '../lib/formats'
import { generatePixels, searchTargetSize } from '../lib/generate'
import type { GeneratedPixels } from '../lib/generate'
import { DEFAULT_SETTINGS, mergeSettings } from '../lib/settings'
import type { Settings } from '../lib/settings'
import { decodeImage } from './decode'
import { encodeImage } from './encode'
import type { GenerateDoneResult, GenerateProgressResult, GenerateRequest } from './protocol'

const LOSSY_FORMATS = new Set<LossyFormat>(['jpeg', 'webp', 'avif', 'jxl'])

function isLossyFormat(format: EncodableFormat): format is LossyFormat {
  return LOSSY_FORMATS.has(format as LossyFormat)
}

function buildSettings(format: EncodableFormat, lossless: boolean, quality?: number): Settings {
  const settings = mergeSettings(DEFAULT_SETTINGS, { format })
  if (format === 'webp' || format === 'avif' || format === 'jxl') {
    settings.lossless = { ...settings.lossless, [format]: lossless }
  }
  if (quality !== undefined && isLossyFormat(format)) {
    settings.quality = { ...settings.quality, [format]: quality }
  }
  return settings
}

function toImageData(pixels: GeneratedPixels): ImageData {
  return new ImageData(pixels.data, pixels.width, pixels.height)
}

async function createPreviewBitmap(format: EncodableFormat, bytes: Uint8Array, fallbackPixels: GeneratedPixels): Promise<ImageBitmap> {
  try {
    const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : bytes.slice().buffer
    const decoded = await decodeImage(format, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMAT_BY_ID[format].mime }), copy)
    return await createImageBitmap(decoded)
  } catch {
    return createImageBitmap(toImageData(fallbackPixels))
  }
}

function toTransferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.slice().buffer
}

export async function runGenerate(req: GenerateRequest): Promise<void> {
  const started = performance.now()
  const formatInfo = FORMAT_BY_ID[req.format]
  const lossless = formatInfo.losslessToggle && req.lossless
  const lossy = isLossyFormat(req.format) && !lossless
  const defaultQuality = isLossyFormat(req.format) ? DEFAULT_SETTINGS.quality[req.format] : 100

  if (req.targetBytes === null) {
    const pixels = generatePixels(req.width, req.height, req.complexity, req.seed)
    const settings = buildSettings(req.format, lossless, lossy ? defaultQuality : undefined)
    const encoded = await encodeImage(req.format, toImageData(pixels), settings)
    const preview = await createPreviewBitmap(req.format, encoded, pixels)
    const outBuffer = toTransferableBuffer(encoded)
    const outWidth = req.format === 'ico' ? Math.max(...settings.ico.sizes) : req.width
    const outHeight = req.format === 'ico' ? Math.max(...settings.ico.sizes) : req.height
    const message: GenerateDoneResult = {
      type: 'generate-done',
      id: req.id,
      bytes: outBuffer,
      preview,
      width: outWidth,
      height: outHeight,
      format: req.format,
      lossless,
      quality: lossy ? defaultQuality : null,
      complexity: req.complexity,
      complexityAdjusted: false,
      status: 'default',
      attempts: 1,
      maxAttempts: 1,
      targetBytes: null,
      ms: performance.now() - started,
    }
    postMessage(message, { transfer: [outBuffer, preview] })
    return
  }

  let latestBytes: Uint8Array | null = null
  let latestPixels: GeneratedPixels | null = null
  let bestBytes: Uint8Array | null = null
  let bestPixels: GeneratedPixels | null = null

  const search = await searchTargetSize({
    width: req.width,
    height: req.height,
    seed: req.seed,
    complexity: req.complexity,
    targetBytes: req.targetBytes,
    lossy,
    defaultQuality,
    encode: async (pixels, quality) => {
      const settings = buildSettings(req.format, lossless, lossy ? quality : undefined)
      const encoded = await encodeImage(req.format, toImageData(pixels), settings)
      latestBytes = encoded
      latestPixels = pixels
      return encoded.byteLength
    },
    onProgress: (progress) => {
      if (progress.isBest && latestBytes && latestPixels) {
        bestBytes = latestBytes
        bestPixels = latestPixels
      }
      const msg: GenerateProgressResult = {
        type: 'generate-progress',
        id: req.id,
        attempt: progress.attempt,
        maxAttempts: progress.maxAttempts,
        size: progress.size,
        quality: progress.quality,
        complexity: progress.complexity,
        phase: progress.phase,
      }
      postMessage(msg)
    },
  })

  if (!bestBytes || !bestPixels) {
    throw new Error('Failed to generate image output')
  }

  const preview = await createPreviewBitmap(req.format, bestBytes, bestPixels)
  const outBuffer = toTransferableBuffer(bestBytes)
  const outWidth = req.format === 'ico' ? Math.max(...DEFAULT_SETTINGS.ico.sizes) : req.width
  const outHeight = req.format === 'ico' ? Math.max(...DEFAULT_SETTINGS.ico.sizes) : req.height

  const done: GenerateDoneResult = {
    type: 'generate-done',
    id: req.id,
    bytes: outBuffer,
    preview,
    width: outWidth,
    height: outHeight,
    format: req.format,
    lossless,
    quality: lossy ? search.quality : null,
    complexity: search.complexity,
    complexityAdjusted: search.complexityAdjusted,
    status: search.status,
    attempts: search.attempts,
    maxAttempts: search.maxAttempts,
    targetBytes: req.targetBytes,
    ms: performance.now() - started,
  }
  postMessage(done, { transfer: [outBuffer, preview] })
}

import type { InputFormat } from '../lib/formats'
import { decodeQoi } from '../lib/codecs/qoi'

let scratchCanvas: OffscreenCanvas | null = null
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null

let heicModulePromise: Promise<{
  heif_context_free?(context: unknown): void
  HeifDecoder: new () => {
    decoder: unknown
    decode(data: Uint8Array): Array<{
      get_width(): number
      get_height(): number
      is_primary?(): boolean
      display(target: ImageData, callback: (result: ImageData | null) => void): void
      free?(): void
    }>
  }
}> | null = null

function toImageData(data: Uint8ClampedArray | Uint8Array, width: number, height: number): ImageData {
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  return new ImageData(clamped as Uint8ClampedArray<ArrayBuffer>, width, height)
}

export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const { width, height } = bitmap
  if (!scratchCanvas || !scratchCtx) {
    scratchCanvas = new OffscreenCanvas(width, height)
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true })
    if (!scratchCtx) { throw new Error('2D canvas is unavailable') }
  } else if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width
    scratchCanvas.height = height
  } else {
    scratchCtx.clearRect(0, 0, width, height)
  }
  scratchCtx.drawImage(bitmap, 0, 0)
  const imageData = scratchCtx.getImageData(0, 0, width, height)
  if (width * height > 4_000_000) {
    scratchCanvas.width = 1
    scratchCanvas.height = 1
  }
  return imageData
}

async function decodeNative(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  })
  try {
    return bitmapToImageData(bitmap)
  } finally {
    bitmap.close()
  }
}

async function getHeicModule() {
  if (!heicModulePromise) {
    heicModulePromise = import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(async ({ default: factory }) => {
      return await factory()
    })
    heicModulePromise.catch(() => {
      heicModulePromise = null
    })
  }
  return heicModulePromise
}

async function decodeHeic(buffer: ArrayBuffer): Promise<ImageData> {
  const libheif = await getHeicModule()
  const decoder = new libheif.HeifDecoder()
  let images: ReturnType<typeof decoder.decode> = []
  try {
    images = decoder.decode(new Uint8Array(buffer))
    if (!images.length) { throw new Error('No image found in HEIC file') }
    const image = images.find((img) => img.is_primary?.()) ?? images[0]
    const width = image.get_width()
    const height = image.get_height()
    return await new Promise<ImageData>((resolve, reject) => {
      const target = new ImageData(width, height)
      image.display(target, (result) => (result ? resolve(result) : reject(new Error('HEIC decode failed'))))
    })
  } finally {
    for (const img of images) { img.free?.() }
    // WARNING: libheif-js frees a heif_context only on that decoder's next decode, so free it here or each file leaks it.
    if (decoder.decoder && libheif.heif_context_free) {
      libheif.heif_context_free(decoder.decoder)
      decoder.decoder = null
    }
  }
}

async function decodeTiff(buffer: ArrayBuffer): Promise<ImageData> {
  const UTIF = (await import('utif2')).default
  const ifds = UTIF.decode(buffer)
  let best = ifds[0]
  let bestArea = 0
  for (const ifd of ifds) {
    UTIF.decodeImage(buffer, ifd)
    const area = (ifd.width ?? 0) * (ifd.height ?? 0)
    if (area > bestArea) {
      best = ifd
      bestArea = area
    }
  }
  if (!best || !bestArea) { throw new Error('No image found in TIFF file') }
  return toImageData(UTIF.toRGBA8(best), best.width, best.height)
}

async function decodeWasm(format: InputFormat, buffer: ArrayBuffer): Promise<ImageData> {
  switch (format) {
    case 'jpeg':
      return (await import('@jsquash/jpeg/decode')).default(buffer)
    case 'png':
      return (await import('@jsquash/png/decode')).default(buffer)
    case 'webp':
      return (await import('@jsquash/webp/decode')).default(buffer)
    case 'avif': {
      const img = await (await import('@jsquash/avif/decode')).default(buffer)
      if (!img) { throw new Error('AVIF decode failed') }
      return img
    }
    case 'jxl':
      return (await import('@jsquash/jxl/decode')).default(buffer)
    case 'heic':
      return decodeHeic(buffer)
    case 'tiff':
      return decodeTiff(buffer)
    case 'qoi': {
      const img = decodeQoi(new Uint8Array(buffer))
      return toImageData(img.data, img.width, img.height)
    }
    default:
      throw new Error(`No decoder for ${format}`)
  }
}

const WASM_FIRST = new Set<InputFormat>(['heic', 'tiff', 'qoi', 'jxl'])

export async function decodeImage(
  format: InputFormat,
  blob: Blob,
  bufferOrLoader: ArrayBuffer | (() => Promise<ArrayBuffer>),
): Promise<ImageData> {
  const loadBuffer = typeof bufferOrLoader === 'function' ? bufferOrLoader : () => Promise.resolve(bufferOrLoader)
  if (WASM_FIRST.has(format)) {
    try {
      return await decodeWasm(format, await loadBuffer())
    } catch (wasmError) {
      try {
        return await decodeNative(blob)
      } catch {
        throw wasmError
      }
    }
  }
  try {
    return await decodeNative(blob)
  } catch (nativeError) {
    try {
      return await decodeWasm(format, await loadBuffer())
    } catch {
      throw nativeError
    }
  }
}

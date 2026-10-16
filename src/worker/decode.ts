import type { InputFormat } from '../lib/formats'
import { decodeQoi } from '../lib/codecs/qoi'

function toImageData(data: Uint8ClampedArray | Uint8Array, width: number, height: number): ImageData {
  const clamped = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  return new ImageData(clamped as Uint8ClampedArray<ArrayBuffer>, width, height)
}

export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas is unavailable')
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

/** Browser decoder: fast, applies EXIF orientation and converts embedded colour profiles to sRGB. */
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

async function decodeHeic(buffer: ArrayBuffer): Promise<ImageData> {
  const { default: factory } = await import('libheif-js/libheif-wasm/libheif-bundle.mjs')
  const libheif = await factory()
  const decoder = new libheif.HeifDecoder()
  const images = decoder.decode(new Uint8Array(buffer))
  if (!images.length) throw new Error('No image found in HEIC file')
  const image = images.find((img) => img.is_primary?.()) ?? images[0]
  const width = image.get_width()
  const height = image.get_height()
  try {
    return await new Promise<ImageData>((resolve, reject) => {
      const target = new ImageData(width, height)
      image.display(target, (result) => (result ? resolve(result) : reject(new Error('HEIC decode failed'))))
    })
  } finally {
    for (const img of images) img.free?.()
  }
}

async function decodeTiff(buffer: ArrayBuffer): Promise<ImageData> {
  const UTIF = (await import('utif2')).default
  const ifds = UTIF.decode(buffer)
  // Skip thumbnails: take the largest image in the file.
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
  if (!best || !bestArea) throw new Error('No image found in TIFF file')
  return toImageData(UTIF.toRGBA8(best), best.width!, best.height!)
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
      if (!img) throw new Error('AVIF decode failed')
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

/** Formats where the WASM decoder is the reliable path everywhere. */
const WASM_FIRST = new Set<InputFormat>(['heic', 'tiff', 'qoi', 'jxl'])

export async function decodeImage(format: InputFormat, blob: Blob, buffer: ArrayBuffer): Promise<ImageData> {
  if (WASM_FIRST.has(format)) {
    try {
      return await decodeWasm(format, buffer)
    } catch (wasmError) {
      // Safari can natively decode HEIC/TIFF/JXL; try that before giving up.
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
      return await decodeWasm(format, buffer)
    } catch {
      throw nativeError
    }
  }
}

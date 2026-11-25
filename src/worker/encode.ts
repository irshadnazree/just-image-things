import type { EncodableFormat } from '../lib/formats'
import type { Settings } from '../lib/settings'
import { encodeBmp, hasAlpha } from '../lib/codecs/bmp'
import { encodeIco, padToSquare } from '../lib/codecs/ico'
import { encodeQoi } from '../lib/codecs/qoi'
import { quantizePixels } from '../lib/codecs/quantize'
import { containInSquare } from '../lib/resize'
import { resizeImage } from './resize'

export interface EncodeOptions {
  /** Precomputed alpha status when already known (avoids rescanning pixels). */
  alpha?: boolean
  /** Thread budget for multi-threaded WASM encoders (>1 uses MT when cross-origin isolated). */
  mtThreads?: number
}

let oxipngStPromise: Promise<
  (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    level: number,
    interlace: boolean,
    optimiseAlpha: boolean,
  ) => Uint8Array
> | null = null

let oxipngMtPromise: Promise<
  (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    level: number,
    interlace: boolean,
    optimiseAlpha: boolean,
  ) => Uint8Array
> | null = null

let avifStPromise: Promise<{
  encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null
}> | null = null

let jxlStPromise: Promise<{
  encode(data: Uint8ClampedArray, width: number, height: number, options: Record<string, unknown>): Uint8Array | null
}> | null = null

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  const n = m ? Number.parseInt(m[1], 16) : 0xff_ff_ff
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function flatten(img: ImageData, background: string, knownAlpha?: boolean): ImageData {
  if (knownAlpha === false || (knownAlpha === undefined && !hasAlpha(img))) { return img }
  const [br, bg, bb] = parseHex(background)
  const src = img.data
  const len = src.length
  const out = new Uint8ClampedArray(len)
  for (let i = 0; i < len; i += 4) {
    const a = src[i + 3]
    if (a === 255) {
      out[i] = src[i]
      out[i + 1] = src[i + 1]
      out[i + 2] = src[i + 2]
      out[i + 3] = 255
    } else if (a === 0) {
      out[i] = br
      out[i + 1] = bg
      out[i + 2] = bb
      out[i + 3] = 255
    } else {
      const inv = 255 - a
      out[i] = ((src[i] * a + br * inv + 127) / 255) | 0
      out[i + 1] = ((src[i + 1] * a + bg * inv + 127) / 255) | 0
      out[i + 2] = ((src[i + 2] * a + bb * inv + 127) / 255) | 0
      out[i + 3] = 255
    }
  }
  return new ImageData(out, img.width, img.height)
}

async function getOxipngSt() {
  if (!oxipngStPromise) {
    oxipngStPromise = import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js').then(async (mod) => {
      await mod.default()
      return mod.optimise_raw
    })
  }
  return oxipngStPromise
}

async function getOxipngMt(threads: number) {
  if (!oxipngMtPromise) {
    oxipngMtPromise = import('@jsquash/oxipng/codec/pkg-parallel/squoosh_oxipng.js').then(async (mod) => {
      await mod.default()
      await mod.initThreadPool(threads)
      return mod.optimise_raw
    })
  }
  return oxipngMtPromise
}

async function getAvifSt() {
  if (!avifStPromise) {
    avifStPromise = import('@jsquash/avif/codec/enc/avif_enc.js').then(({ default: factory }) => factory())
  }
  return avifStPromise
}

async function getJxlSt() {
  if (!jxlStPromise) {
    jxlStPromise = import('@jsquash/jxl/codec/enc/jxl_enc.js').then(({ default: factory }) => factory())
  }
  return jxlStPromise
}

const canUseMt = (mtThreads?: number) =>
  (mtThreads ?? 1) > 1 && Boolean(globalThis.crossOriginIsolated) && typeof SharedArrayBuffer !== 'undefined'

async function encodePng(img: ImageData, settings: Settings, opts: EncodeOptions): Promise<Uint8Array> {
  const alpha = opts.alpha ?? hasAlpha(img)
  let source = img
  if (settings.png.colors > 0) {
    const { palette, index } = quantizePixels(img.data, settings.png.colors, { alpha, oneBitAlpha: false })
    const out = new Uint8ClampedArray(img.data.length)
    const outU32 = new Uint32Array(out.buffer)
    const packedPalette = new Uint32Array(palette.length)
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i]
      const a = c[3] ?? 255
      packedPalette[i] = ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0
    }
    for (let i = 0; i < index.length; i++) {
      outU32[i] = packedPalette[index[i]]
    }
    source = new ImageData(out, img.width, img.height)
  }
  if (settings.effort.png > 0) {
    if (canUseMt(opts.mtThreads)) {
      const optimiseRaw = await getOxipngMt(opts.mtThreads ?? 2)
      return new Uint8Array(optimiseRaw(source.data, source.width, source.height, settings.effort.png, false, alpha))
    }
    const optimiseRaw = await getOxipngSt()
    return new Uint8Array(optimiseRaw(source.data, source.width, source.height, settings.effort.png, false, alpha))
  }
  const encode = (await import('@jsquash/png/encode')).default
  return new Uint8Array(await encode(source))
}

async function encodeGif(img: ImageData, settings: Settings, opts: EncodeOptions): Promise<Uint8Array> {
  const { GIFEncoder } = await import('gifenc')
  const alpha = opts.alpha ?? hasAlpha(img)
  const { palette, index, transparentIndex } = quantizePixels(img.data, settings.gif.colors, {
    alpha,
    oneBitAlpha: alpha,
  })
  const gif = GIFEncoder()
  gif.writeFrame(index, img.width, img.height, {
    palette,
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(0, transparentIndex),
  })
  gif.finish()
  return gif.bytes()
}

async function encodeIcon(img: ImageData, settings: Settings, opts: EncodeOptions): Promise<Uint8Array> {
  const encode = (await import('@jsquash/png/encode')).default
  const sizes = settings.ico.sizes.length ? [...settings.ico.sizes].sort((a, b) => b - a) : [32]
  const alpha = opts.alpha ?? hasAlpha(img)
  const pyramid: Array<ImageData> = [img]
  const entries = []
  for (const side of sizes) {
    const fit = containInSquare(img.width, img.height, side)
    let source = img
    let bestArea = img.width * img.height
    for (const candidate of pyramid) {
      if (candidate.width === fit.width && candidate.height === fit.height) {
        source = candidate
        break
      }
      if (candidate.width >= fit.width * 2 && candidate.height >= fit.height * 2) {
        const area = candidate.width * candidate.height
        if (area < bestArea) {
          source = candidate
          bestArea = area
        }
      }
    }
    const resized =
      fit.width === source.width && fit.height === source.height
        ? source
        : await resizeImage(source, fit.width, fit.height, settings.resize.method, alpha)
    if (resized !== source) {
      pyramid.push(resized)
    }
    const square = padToSquare(resized.data, resized.width, resized.height, side)
    const png = await encode(new ImageData(square as Uint8ClampedArray<ArrayBuffer>, side, side))
    entries.push({ size: side, png: new Uint8Array(png) })
  }
  return encodeIco(entries)
}

async function encodeAvif(img: ImageData, settings: Settings, opts: EncodeOptions): Promise<Uint8Array> {
  if (canUseMt(opts.mtThreads)) {
    const encode = (await import('@jsquash/avif/encode')).default
    const tileColsLog2 = img.width >= 2560 ? 2 : img.width >= 1280 ? 1 : 0
    const tileRowsLog2 = img.height >= 1440 ? 1 : 0
    return new Uint8Array(
      await encode(img, {
        quality: settings.quality.avif,
        speed: 10 - settings.effort.avif,
        lossless: settings.lossless.avif,
        tileColsLog2,
        tileRowsLog2,
      }),
    )
  }
  const { defaultOptions } = await import('@jsquash/avif/meta')
  const module = await getAvifSt()
  const lossless = settings.lossless.avif
  const options = {
    ...defaultOptions,
    quality: lossless ? 100 : settings.quality.avif,
    qualityAlpha: lossless ? -1 : defaultOptions.qualityAlpha,
    subsample: lossless ? 3 : defaultOptions.subsample,
    speed: 10 - settings.effort.avif,
    lossless,
  }
  const input = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
  const output = module.encode(input, img.width, img.height, options)
  if (!output) { throw new Error('AVIF encoding failed') }
  return new Uint8Array(output.buffer)
}

async function encodeJxl(img: ImageData, settings: Settings, opts: EncodeOptions): Promise<Uint8Array> {
  if (canUseMt(opts.mtThreads)) {
    const encode = (await import('@jsquash/jxl/encode')).default
    return new Uint8Array(
      await encode(img, {
        quality: settings.lossless.jxl ? 100 : settings.quality.jxl,
        effort: settings.effort.jxl,
        lossless: settings.lossless.jxl,
      }),
    )
  }
  const { defaultOptions } = await import('@jsquash/jxl/meta')
  const module = await getJxlSt()
  const lossless = settings.lossless.jxl
  const options = {
    ...defaultOptions,
    quality: lossless ? 100 : settings.quality.jxl,
    effort: settings.effort.jxl,
    lossless,
    lossyModular: lossless ? false : defaultOptions.lossyModular,
    lossyPalette: lossless ? false : defaultOptions.lossyPalette,
  }
  const output = module.encode(img.data, img.width, img.height, options)
  if (!output) { throw new Error('JPEG XL encoding failed') }
  return new Uint8Array(output.buffer)
}

export async function encodeImage(
  format: EncodableFormat,
  img: ImageData,
  settings: Settings,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  switch (format) {
    case 'jpeg': {
      const encode = (await import('@jsquash/jpeg/encode')).default
      const buf = await encode(flatten(img, settings.jpeg.background, opts.alpha), {
        quality: settings.quality.jpeg,
        progressive: settings.jpeg.progressive,
        optimize_coding: true,
      })
      return new Uint8Array(buf)
    }
    case 'png':
      return encodePng(img, settings, opts)
    case 'webp': {
      const encode = (await import('@jsquash/webp/encode')).default
      const lossless = settings.lossless.webp
      return new Uint8Array(
        await encode(img, {
          quality: lossless ? 100 : settings.quality.webp,
          method: settings.effort.webp,
          lossless: lossless ? 1 : 0,
          exact: lossless ? 1 : 0,
        }),
      )
    }
    case 'avif':
      return encodeAvif(img, settings, opts)
    case 'jxl':
      return encodeJxl(img, settings, opts)
    case 'gif':
      return encodeGif(img, settings, opts)
    case 'tiff': {
      const UTIF = (await import('utif2')).default
      return new Uint8Array(UTIF.encodeImage(new Uint8Array(img.data.buffer), img.width, img.height))
    }
    case 'bmp':
      return encodeBmp(img, opts.alpha)
    case 'ico':
      return encodeIcon(img, settings, opts)
    case 'qoi': {
      const alpha = opts.alpha ?? hasAlpha(img)
      return encodeQoi(img, alpha ? 4 : 3)
    }
  }
}

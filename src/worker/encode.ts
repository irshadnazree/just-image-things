import type { EncodableFormat } from '../lib/formats'
import type { Settings } from '../lib/settings'
import { encodeBmp, hasAlpha } from '../lib/codecs/bmp'
import { encodeIco, padToSquare } from '../lib/codecs/ico'
import { encodeQoi } from '../lib/codecs/qoi'
import { containInSquare } from '../lib/resize'
import { resizeImage } from './resize'

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  const n = m ? parseInt(m[1], 16) : 0xffffff
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** JPEG has no alpha, so composite transparent pixels over a solid colour. */
function flatten(img: ImageData, background: string): ImageData {
  if (!hasAlpha(img)) return img
  const [br, bg, bb] = parseHex(background)
  const src = img.data
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255
    out[i] = src[i] * a + br * (1 - a)
    out[i + 1] = src[i + 1] * a + bg * (1 - a)
    out[i + 2] = src[i + 2] * a + bb * (1 - a)
    out[i + 3] = 255
  }
  return new ImageData(out, img.width, img.height)
}

/** Reduce to a palette (like pngquant, minus the dithering). */
async function quantizeImage(img: ImageData, colors: number) {
  const { quantize, applyPalette } = await import('gifenc')
  const alpha = hasAlpha(img)
  const format = alpha ? 'rgba4444' : 'rgb565'
  const palette = quantize(img.data, colors, { format, oneBitAlpha: false })
  const index = applyPalette(img.data, palette, format)
  return { palette, index }
}

async function encodePng(img: ImageData, settings: Settings): Promise<Uint8Array> {
  let source = img
  if (settings.png.colors > 0) {
    const { palette, index } = await quantizeImage(img, settings.png.colors)
    const out = new Uint8ClampedArray(img.data.length)
    for (let i = 0; i < index.length; i++) {
      const c = palette[index[i]]
      out[i * 4] = c[0]
      out[i * 4 + 1] = c[1]
      out[i * 4 + 2] = c[2]
      out[i * 4 + 3] = c.length > 3 ? c[3] : 255
    }
    source = new ImageData(out, img.width, img.height)
  }
  if (settings.effort.png > 0) {
    const optimise = (await import('@jsquash/oxipng/optimise')).default
    return new Uint8Array(await optimise(source, { level: settings.effort.png, optimiseAlpha: true }))
  }
  const encode = (await import('@jsquash/png/encode')).default
  return new Uint8Array(await encode(source))
}

async function encodeGif(img: ImageData, settings: Settings): Promise<Uint8Array> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const alpha = hasAlpha(img)
  const format = alpha ? 'rgba4444' : 'rgb565'
  const palette = quantize(img.data, settings.gif.colors, { format, oneBitAlpha: alpha })
  const index = applyPalette(img.data, palette, format)
  const transparentIndex = alpha ? palette.findIndex((c) => c[3] === 0) : -1
  const gif = GIFEncoder()
  gif.writeFrame(index, img.width, img.height, {
    palette,
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(0, transparentIndex),
  })
  gif.finish()
  return gif.bytes()
}

async function encodeIcon(img: ImageData, settings: Settings): Promise<Uint8Array> {
  const encode = (await import('@jsquash/png/encode')).default
  const sizes = settings.ico.sizes.length ? settings.ico.sizes : [32]
  const entries = []
  for (const side of sizes) {
    const fit = containInSquare(img.width, img.height, side)
    const resized =
      fit.width === img.width && fit.height === img.height
        ? img
        : await resizeImage(img, fit.width, fit.height, settings.resize.method)
    const square = padToSquare(resized.data, resized.width, resized.height, side)
    const png = await encode(new ImageData(square as Uint8ClampedArray<ArrayBuffer>, side, side))
    entries.push({ size: side, png: new Uint8Array(png) })
  }
  return encodeIco(entries)
}

export async function encodeImage(format: EncodableFormat, img: ImageData, settings: Settings): Promise<Uint8Array> {
  switch (format) {
    case 'jpeg': {
      const encode = (await import('@jsquash/jpeg/encode')).default
      const buf = await encode(flatten(img, settings.jpeg.background), {
        quality: settings.quality.jpeg,
        progressive: settings.jpeg.progressive,
        optimize_coding: true,
      })
      return new Uint8Array(buf)
    }
    case 'png':
      return encodePng(img, settings)
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
    case 'avif': {
      const encode = (await import('@jsquash/avif/encode')).default
      return new Uint8Array(
        await encode(img, {
          quality: settings.quality.avif,
          speed: 10 - settings.effort.avif,
          lossless: settings.lossless.avif,
        }),
      )
    }
    case 'jxl': {
      const encode = (await import('@jsquash/jxl/encode')).default
      return new Uint8Array(
        await encode(img, {
          quality: settings.lossless.jxl ? 100 : settings.quality.jxl,
          effort: settings.effort.jxl,
          lossless: settings.lossless.jxl,
        }),
      )
    }
    case 'gif':
      return encodeGif(img, settings)
    case 'tiff': {
      const UTIF = (await import('utif2')).default
      return new Uint8Array(UTIF.encodeImage(new Uint8Array(img.data.buffer), img.width, img.height))
    }
    case 'bmp':
      return encodeBmp(img)
    case 'ico':
      return encodeIcon(img, settings)
    case 'qoi':
      return encodeQoi(img, hasAlpha(img) ? 4 : 3)
  }
}

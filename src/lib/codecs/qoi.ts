// The "Quite OK Image" format: https://qoiformat.org/qoi-specification.pdf
import type { RGBAImage } from './bmp'

const OP_INDEX = 0x00
const OP_DIFF = 0x40
const OP_LUMA = 0x80
const OP_RUN = 0xc0
const OP_RGB = 0xfe
const OP_RGBA = 0xff
const MASK_2 = 0xc0

const hash = (r: number, g: number, b: number, a: number) => (r * 3 + g * 5 + b * 7 + a * 11) % 64

export function encodeQoi(img: RGBAImage, channels: 3 | 4 = 4): Uint8Array {
  const { width, height, data } = img
  const pixels = width * height
  const out = new Uint8Array(14 + pixels * 5 + 8)
  const v = new DataView(out.buffer)
  out.set([0x71, 0x6f, 0x69, 0x66]) // 'qoif'
  v.setUint32(4, width)
  v.setUint32(8, height)
  out[12] = channels
  out[13] = 0 // sRGB with linear alpha

  const index = new Uint8Array(64 * 4)
  let p = 14
  let run = 0
  let pr = 0,
    pg = 0,
    pb = 0,
    pa = 255

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const r = data[o],
      g = data[o + 1],
      b = data[o + 2],
      a = data[o + 3]

    if (r === pr && g === pg && b === pb && a === pa) {
      run++
      if (run === 62 || i === pixels - 1) {
        out[p++] = OP_RUN | (run - 1)
        run = 0
      }
      continue
    }
    if (run > 0) {
      out[p++] = OP_RUN | (run - 1)
      run = 0
    }

    const h = hash(r, g, b, a) * 4
    if (index[h] === r && index[h + 1] === g && index[h + 2] === b && index[h + 3] === a) {
      out[p++] = OP_INDEX | (h / 4)
    } else {
      index[h] = r
      index[h + 1] = g
      index[h + 2] = b
      index[h + 3] = a
      if (a === pa) {
        const dr = ((r - pr + 384) % 256) - 128
        const dg = ((g - pg + 384) % 256) - 128
        const db = ((b - pb + 384) % 256) - 128
        const drg = dr - dg
        const dbg = db - dg
        if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) {
          out[p++] = OP_DIFF | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)
        } else if (drg > -9 && drg < 8 && dg > -33 && dg < 32 && dbg > -9 && dbg < 8) {
          out[p++] = OP_LUMA | (dg + 32)
          out[p++] = ((drg + 8) << 4) | (dbg + 8)
        } else {
          out[p++] = OP_RGB
          out[p++] = r
          out[p++] = g
          out[p++] = b
        }
      } else {
        out[p++] = OP_RGBA
        out[p++] = r
        out[p++] = g
        out[p++] = b
        out[p++] = a
      }
    }
    pr = r
    pg = g
    pb = b
    pa = a
  }
  out.set([0, 0, 0, 0, 0, 0, 0, 1], p)
  return out.slice(0, p + 8)
}

export function decodeQoi(bytes: Uint8Array): RGBAImage {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0) !== 0x716f6966) throw new Error('Not a QOI file')
  const width = v.getUint32(4)
  const height = v.getUint32(8)
  const pixels = width * height
  const data = new Uint8ClampedArray(pixels * 4)
  const index = new Uint8Array(64 * 4)
  let r = 0,
    g = 0,
    b = 0,
    a = 255
  let p = 14
  const end = bytes.length - 8

  for (let i = 0; i < pixels; ) {
    if (p >= end) throw new Error('Truncated QOI file')
    const op = bytes[p++]
    let run = 1
    if (op === OP_RGB) {
      r = bytes[p++]
      g = bytes[p++]
      b = bytes[p++]
    } else if (op === OP_RGBA) {
      r = bytes[p++]
      g = bytes[p++]
      b = bytes[p++]
      a = bytes[p++]
    } else if ((op & MASK_2) === OP_INDEX) {
      const h = op * 4
      r = index[h]
      g = index[h + 1]
      b = index[h + 2]
      a = index[h + 3]
    } else if ((op & MASK_2) === OP_DIFF) {
      r = (r + ((op >> 4) & 3) - 2) & 255
      g = (g + ((op >> 2) & 3) - 2) & 255
      b = (b + (op & 3) - 2) & 255
    } else if ((op & MASK_2) === OP_LUMA) {
      const next = bytes[p++]
      const dg = (op & 0x3f) - 32
      r = (r + dg - 8 + ((next >> 4) & 0x0f)) & 255
      g = (g + dg) & 255
      b = (b + dg - 8 + (next & 0x0f)) & 255
    } else {
      run = (op & 0x3f) + 1
    }
    const h = hash(r, g, b, a) * 4
    index[h] = r
    index[h + 1] = g
    index[h + 2] = b
    index[h + 3] = a
    for (; run > 0 && i < pixels; run--, i++) {
      const o = i * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = a
    }
  }
  return { data, width, height }
}

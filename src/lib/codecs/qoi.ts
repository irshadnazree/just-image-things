import type { RGBAImage } from './bmp'

const OP_INDEX = 0x00
const OP_DIFF = 0x40
const OP_LUMA = 0x80
const OP_RUN = 0xc0
const OP_RGB = 0xfe
const OP_RGBA = 0xff
const MASK_2 = 0xc0

export function encodeQoi(img: RGBAImage, channels: 3 | 4 = 4): Uint8Array {
  const { width, height, data } = img
  const pixels = width * height
  const out = new Uint8Array(14 + pixels * 5 + 8)
  const v = new DataView(out.buffer)
  out[0] = 0x71
  out[1] = 0x6f
  out[2] = 0x69
  out[3] = 0x66
  v.setUint32(4, width)
  v.setUint32(8, height)
  out[12] = channels
  out[13] = 0

  const index = new Uint32Array(64)
  const lastPixel = pixels - 1
  const u32 =
    data.byteOffset % 4 === 0 && (data.byteLength & 3) === 0
      ? new Uint32Array(data.buffer, data.byteOffset, pixels)
      : null

  let p = 14
  let run = 0
  let pr = 0
  let pg = 0
  let pb = 0
  let pa = 255
  let prevPacked = 0xff_00_00_00

  for (let i = 0; i < pixels; i++) {
    let packed: number
    let r: number
    let g: number
    let b: number
    let a: number
    if (u32) {
      packed = u32[i]
      if (packed === prevPacked) {
        run++
        if (run === 62 || i === lastPixel) {
          out[p++] = OP_RUN | (run - 1)
          run = 0
        }
        continue
      }
      r = packed & 255
      g = (packed >>> 8) & 255
      b = (packed >>> 16) & 255
      a = packed >>> 24
    } else {
      const o = i * 4
      r = data[o]
      g = data[o + 1]
      b = data[o + 2]
      a = data[o + 3]
      packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      if (packed === prevPacked) {
        run++
        if (run === 62 || i === lastPixel) {
          out[p++] = OP_RUN | (run - 1)
          run = 0
        }
        continue
      }
    }

    if (run > 0) {
      out[p++] = OP_RUN | (run - 1)
      run = 0
    }

    const h = (r * 3 + g * 5 + b * 7 + a * 11) & 63
    if (index[h] === packed) {
      out[p++] = OP_INDEX | h
    } else {
      index[h] = packed
      if (a === pa) {
        const dr = ((r - pr) << 24) >> 24
        const dg = ((g - pg) << 24) >> 24
        const db = ((b - pb) << 24) >> 24
        const drg = dr - dg
        const dbg = db - dg
        if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) {
          out[p++] = OP_DIFF | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2)
        } else if (drg > -9 && drg < 8 && dg > -33 && dg < 32 && dbg > -9 && dbg < 8) {
          out[p++] = OP_LUMA | (dg + 32)
          out[p++] = ((drg + 8) << 4) | (dbg + 8)
        } else {
          out[p] = OP_RGB
          out[p + 1] = r
          out[p + 2] = g
          out[p + 3] = b
          p += 4
        }
      } else {
        out[p] = OP_RGBA
        out[p + 1] = r
        out[p + 2] = g
        out[p + 3] = b
        out[p + 4] = a
        p += 5
      }
    }
    pr = r
    pg = g
    pb = b
    pa = a
    prevPacked = packed
  }
  out[p] = 0
  out[p + 1] = 0
  out[p + 2] = 0
  out[p + 3] = 0
  out[p + 4] = 0
  out[p + 5] = 0
  out[p + 6] = 0
  out[p + 7] = 1
  return out.slice(0, p + 8)
}

export function decodeQoi(bytes: Uint8Array): RGBAImage {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0) !== 0x71_6f_69_66) { throw new Error('Not a QOI file') }
  const width = v.getUint32(4)
  const height = v.getUint32(8)
  const pixels = width * height
  const data = new Uint8ClampedArray(pixels * 4)
  const u32 = new Uint32Array(data.buffer)
  const index = new Uint32Array(64)
  let r = 0
  let g = 0
  let b = 0
  let a = 255
  let packed = 0xff_00_00_00
  let p = 14
  const end = bytes.length - 8

  for (let i = 0; i < pixels; ) {
    if (p >= end) { throw new Error('Truncated QOI file') }
    const op = bytes[p++]
    if (op === OP_RGB) {
      r = bytes[p]
      g = bytes[p + 1]
      b = bytes[p + 2]
      p += 3
      packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = packed
      u32[i++] = packed
    } else if (op === OP_RGBA) {
      r = bytes[p]
      g = bytes[p + 1]
      b = bytes[p + 2]
      a = bytes[p + 3]
      p += 4
      packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = packed
      u32[i++] = packed
    } else {
      const tag = op & MASK_2
      if (tag === OP_INDEX) {
        packed = index[op]
        r = packed & 255
        g = (packed >>> 8) & 255
        b = (packed >>> 16) & 255
        a = packed >>> 24
        u32[i++] = packed
      } else if (tag === OP_DIFF) {
        r = (r + ((op >> 4) & 3) - 2) & 255
        g = (g + ((op >> 2) & 3) - 2) & 255
        b = (b + (op & 3) - 2) & 255
        packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
        index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = packed
        u32[i++] = packed
      } else if (tag === OP_LUMA) {
        const next = bytes[p++]
        const dg = (op & 0x3f) - 32
        r = (r + dg - 8 + ((next >> 4) & 0x0f)) & 255
        g = (g + dg) & 255
        b = (b + dg - 8 + (next & 0x0f)) & 255
        packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
        index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = packed
        u32[i++] = packed
      } else {
        const run = (op & 0x3f) + 1
        const stop = Math.min(pixels, i + run)
        u32.fill(packed, i, stop)
        i = stop
      }
    }
  }
  return { data, width, height }
}

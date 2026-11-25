export interface RGBAImage {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export function hasAlpha(img: RGBAImage): boolean {
  const d = img.data
  if (d.byteOffset % 4 === 0 && (d.byteLength & 3) === 0) {
    const u32 = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >>> 2)
    const len = u32.length
    const limit = len - 3
    let i = 0
    for (; i < limit; i += 4) {
      if (((u32[i] & u32[i + 1] & u32[i + 2] & u32[i + 3]) >>> 24) !== 255) { return true }
    }
    for (; i < len; i++) {
      if ((u32[i] >>> 24) !== 255) { return true }
    }
    return false
  }
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) { return true }
  }
  return false
}

/** 24-bit BMP for opaque images, 32-bit BITMAPV4 with an alpha mask otherwise. */
export function encodeBmp(img: RGBAImage, knownAlpha?: boolean): Uint8Array {
  const { width, height, data } = img
  const alpha = knownAlpha ?? hasAlpha(img)
  const bpp = alpha ? 4 : 3
  const rowSize = Math.ceil((width * bpp) / 4) * 4
  const headerSize = alpha ? 108 : 40
  const pixelOffset = 14 + headerSize
  const fileSize = pixelOffset + rowSize * height
  const out = new Uint8Array(fileSize)
  const v = new DataView(out.buffer)

  out[0] = 0x42
  out[1] = 0x4d
  v.setUint32(2, fileSize, true)
  v.setUint32(10, pixelOffset, true)

  v.setUint32(14, headerSize, true)
  v.setInt32(18, width, true)
  v.setInt32(22, height, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, bpp * 8, true)
  v.setUint32(30, alpha ? 3 : 0, true)
  v.setUint32(34, rowSize * height, true)
  v.setInt32(38, 2835, true)
  v.setInt32(42, 2835, true)
  if (alpha) {
    v.setUint32(54, 0x00_ff_00_00, true)
    v.setUint32(58, 0x00_00_ff_00, true)
    v.setUint32(62, 0x00_00_00_ff, true)
    v.setUint32(66, 0xff_00_00_00, true)
    v.setUint32(70, 0x73_52_47_42, true)
  }

  const srcStride = width * 4
  if (alpha) {
    for (let y = 0; y < height; y++) {
      let o = pixelOffset + (height - 1 - y) * rowSize
      let i = y * srcStride
      const end = i + srcStride
      for (; i < end; i += 4) {
        out[o] = data[i + 2]
        out[o + 1] = data[i + 1]
        out[o + 2] = data[i]
        out[o + 3] = data[i + 3]
        o += 4
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      let o = pixelOffset + (height - 1 - y) * rowSize
      let i = y * srcStride
      const end = i + srcStride
      for (; i < end; i += 4) {
        out[o] = data[i + 2]
        out[o + 1] = data[i + 1]
        out[o + 2] = data[i]
        o += 3
      }
    }
  }
  return out
}

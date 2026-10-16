export interface RGBAImage {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export function hasAlpha(img: RGBAImage): boolean {
  const d = img.data
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true
  return false
}

/** 24-bit BMP for opaque images, 32-bit BITMAPV4 with an alpha mask otherwise. */
export function encodeBmp(img: RGBAImage): Uint8Array {
  const { width, height, data } = img
  const alpha = hasAlpha(img)
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
  v.setInt32(22, height, true) // positive height = bottom-up rows
  v.setUint16(26, 1, true)
  v.setUint16(28, bpp * 8, true)
  v.setUint32(30, alpha ? 3 : 0, true) // BI_BITFIELDS : BI_RGB
  v.setUint32(34, rowSize * height, true)
  v.setInt32(38, 2835, true) // 72 DPI
  v.setInt32(42, 2835, true)
  if (alpha) {
    v.setUint32(54, 0x00ff0000, true)
    v.setUint32(58, 0x0000ff00, true)
    v.setUint32(62, 0x000000ff, true)
    v.setUint32(66, 0xff000000, true)
    v.setUint32(70, 0x73524742, true) // 'sRGB'
  }

  for (let y = 0; y < height; y++) {
    let o = pixelOffset + (height - 1 - y) * rowSize
    let i = y * width * 4
    for (let x = 0; x < width; x++, i += 4) {
      out[o++] = data[i + 2]
      out[o++] = data[i + 1]
      out[o++] = data[i]
      if (alpha) out[o++] = data[i + 3]
    }
  }
  return out
}

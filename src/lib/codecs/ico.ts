export interface IcoEntry {
  size: number
  png: Uint8Array
}

/** Pack PNG-encoded square images into a single .ico (supported since Windows Vista). */
export function encodeIco(entries: IcoEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.size - b.size)
  const headerSize = 6 + 16 * sorted.length
  const total = headerSize + sorted.reduce((sum, e) => sum + e.png.length, 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)

  v.setUint16(2, 1, true) // type: icon
  v.setUint16(4, sorted.length, true)

  let offset = headerSize
  sorted.forEach((entry, i) => {
    const p = 6 + i * 16
    out[p] = entry.size >= 256 ? 0 : entry.size
    out[p + 1] = entry.size >= 256 ? 0 : entry.size
    v.setUint16(p + 4, 1, true) // colour planes
    v.setUint16(p + 6, 32, true) // bits per pixel
    v.setUint32(p + 8, entry.png.length, true)
    v.setUint32(p + 12, offset, true)
    out.set(entry.png, offset)
    offset += entry.png.length
  })
  return out
}

/** Centre an RGBA image on a transparent square canvas. */
export function padToSquare(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  side: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(side * side * 4)
  const ox = Math.floor((side - width) / 2)
  const oy = Math.floor((side - height) / 2)
  for (let y = 0; y < height; y++) {
    out.set(data.subarray(y * width * 4, (y + 1) * width * 4), ((y + oy) * side + ox) * 4)
  }
  return out
}

// Minimal JPEG EXIF handling: lift the APP1 segment out of the source, fix it up
// for the re-encoded pixels, and splice it into the new file.

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

const TAG_ORIENTATION = 0x0112
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_PIXEL_X = 0xa002
const TAG_PIXEL_Y = 0xa003

/** Returns the whole APP1 Exif segment (marker included), or null. */
export function extractExifSegment(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
  let p = 2
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) return null
    const marker = jpeg[p + 1]
    if (marker === 0xda || marker === 0xd9) return null // start of scan / end of image
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3]
    if (
      marker === 0xe1 &&
      jpeg[p + 4] === 0x45 && // E
      jpeg[p + 5] === 0x78 && // x
      jpeg[p + 6] === 0x69 && // i
      jpeg[p + 7] === 0x66 // f
    ) {
      return jpeg.slice(p, p + 2 + len)
    }
    p += 2 + len
  }
  return null
}

/** EXIF orientation (1–8), or 1 when absent. */
export function readOrientation(segment: Uint8Array | null): number {
  const tiff = 10
  if (!segment || segment.length < tiff + 8) return 1
  const v = new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
  const le = v.getUint16(tiff) === 0x4949
  const ifd0 = tiff + v.getUint32(tiff + 4, le)
  if (ifd0 + 2 > segment.length) return 1
  const n = v.getUint16(ifd0, le)
  for (let i = 0; i < n; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > segment.length) break
    if (v.getUint16(entry, le) === TAG_ORIENTATION) return v.getUint16(entry + 8, le) || 1
  }
  return 1
}

export interface ExifPatch {
  /** New pixel dimensions; omit when the pixels are untouched. */
  width?: number
  height?: number
  stripGps: boolean
  /** Pixels were re-encoded upright, so orientation must become 1 and the thumbnail goes. */
  reencoded: boolean
}

/**
 * Mutates an APP1 segment in place: orientation becomes 1 (pixels are already upright),
 * pixel dimensions are updated, the embedded thumbnail is unlinked and GPS data can be wiped.
 */
export function patchExifSegment(segment: Uint8Array, patch: ExifPatch): Uint8Array {
  const tiff = 10 // FF E1 len(2) "Exif\0\0"
  if (segment.length < tiff + 8) return segment
  const v = new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
  const le = v.getUint16(tiff) === 0x4949
  const u16 = (o: number) => v.getUint16(tiff + o, le)
  const u32 = (o: number) => v.getUint32(tiff + o, le)
  const inRange = (o: number, n: number) => o >= 0 && tiff + o + n <= segment.length

  const walk = (ifd: number, visit: (entry: number, tag: number, type: number, count: number) => void) => {
    if (!inRange(ifd, 2)) return
    const n = u16(ifd)
    for (let i = 0; i < n; i++) {
      const entry = ifd + 2 + i * 12
      if (!inRange(entry, 12)) return
      visit(entry, u16(entry), u16(entry + 2), u32(entry + 4))
    }
  }

  const writeDim = (entry: number, type: number, value: number) => {
    if (type === 3) v.setUint16(tiff + entry + 8, value, le)
    else if (type === 4) v.setUint32(tiff + entry + 8, value, le)
  }

  const ifd0 = u32(4)
  let exifIfd = -1
  let gpsIfd = -1
  walk(ifd0, (entry, tag, type) => {
    if (patch.reencoded && tag === TAG_ORIENTATION && type === 3) v.setUint16(tiff + entry + 8, 1, le)
    if (tag === TAG_EXIF_IFD) exifIfd = u32(entry + 8)
    if (tag === TAG_GPS_IFD) gpsIfd = u32(entry + 8)
  })

  // Unlink IFD1 (the thumbnail): it still shows the old orientation and size.
  if (patch.reencoded && inRange(ifd0, 2)) {
    const next = ifd0 + 2 + u16(ifd0) * 12
    if (inRange(next, 4)) v.setUint32(tiff + next, 0, le)
  }

  if (exifIfd > 0 && patch.width && patch.height) {
    const { width, height } = patch
    walk(exifIfd, (entry, tag, type) => {
      if (tag === TAG_PIXEL_X) writeDim(entry, type, width)
      if (tag === TAG_PIXEL_Y) writeDim(entry, type, height)
    })
  }

  if (patch.stripGps && gpsIfd > 0) {
    walk(gpsIfd, (entry, _tag, type, count) => {
      const size = (TYPE_SIZES[type] ?? 1) * count
      if (size > 4) {
        const off = u32(entry + 8)
        if (inRange(off, size)) segment.fill(0, tiff + off, tiff + off + size)
      }
      segment.fill(0, tiff + entry, tiff + entry + 12)
    })
    if (inRange(gpsIfd, 2)) v.setUint16(tiff + gpsIfd, 0, le)
  }
  return segment
}

/** Insert an APP1 segment after SOI (and after APP0/JFIF if present). */
export function insertExifSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  let at = 2
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5])
  const out = new Uint8Array(jpeg.length + segment.length)
  out.set(jpeg.subarray(0, at))
  out.set(segment, at)
  out.set(jpeg.subarray(at), at + segment.length)
  return out
}

/**
 * Losslessly drop metadata segments (EXIF/XMP APP1, IPTC APP13, comments) from a JPEG.
 * The ICC profile (APP2) is kept so colours don't shift.
 */
export function stripJpegMetadata(jpeg: Uint8Array, keep?: Uint8Array | null): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)]
  if (keep) parts.push(keep)
  let p = 2
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff) {
    const marker = jpeg[p + 1]
    if (marker === 0xda) break
    const end = p + 2 + ((jpeg[p + 2] << 8) | jpeg[p + 3])
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe
    if (!drop) parts.push(jpeg.subarray(p, end))
    p = end
  }
  parts.push(jpeg.subarray(p))
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

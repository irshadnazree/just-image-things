import { describe, expect, it } from 'vitest'
import { encodeBmp } from '../codecs/bmp'
import { encodeIco, padToSquare } from '../codecs/ico'
import { decodeQoi, encodeQoi } from '../codecs/qoi'
import { extractExifSegment, insertExifSegment, patchExifSegment, readOrientation, stripJpegMetadata } from '../exif'
import { isSupportedName, resolveOutputFormat, sniffFormat } from '../formats'
import { outputPath, renderName, reservePath, sanitizeName } from '../naming'
import { targetSize } from '../resize'
import { DEFAULT_SETTINGS, mergeSettings } from '../settings'

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])))

describe('sniffFormat', () => {
  it('detects formats from magic bytes regardless of extension', () => {
    expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.png')).toBe('jpeg')
    expect(sniffFormat(bytes(0x89, 'PNG'))).toBe('png')
    expect(sniffFormat(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp')
    expect(sniffFormat(bytes('GIF89a'))).toBe('gif')
    expect(sniffFormat(bytes('II', 0x2a, 0))).toBe('tiff')
    expect(sniffFormat(bytes('qoif'))).toBe('qoi')
    expect(sniffFormat(bytes(0xff, 0x0a))).toBe('jxl')
    expect(sniffFormat(bytes(0, 0, 1, 0, 1, 0))).toBe('ico')
  })

  it('tells AVIF and HEIC apart by ftyp brands', () => {
    const ftyp = (major: string, ...compat: string[]) => {
      const size = 16 + compat.length * 4
      return bytes(0, 0, 0, size, 'ftyp', major, 0, 0, 0, 0, ...compat)
    }
    expect(sniffFormat(ftyp('heic', 'mif1', 'heic'))).toBe('heic')
    expect(sniffFormat(ftyp('avif', 'mif1', 'avif'))).toBe('avif')
    expect(sniffFormat(ftyp('mif1', 'avif', 'miaf'))).toBe('avif')
    expect(sniffFormat(ftyp('mif1', 'heic'))).toBe('heic')
  })

  it('falls back to extension, and recognises SVG text', () => {
    expect(sniffFormat(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'))).toBe('svg')
    expect(sniffFormat(bytes(1, 2, 3), 'photo.HEIC')).toBe('heic')
    expect(sniffFormat(bytes(1, 2, 3), 'notes.txt')).toBeNull()
  })
})

describe('isSupportedName', () => {
  it('skips junk and unsupported files', () => {
    expect(isSupportedName('IMG_1.HEIC')).toBe(true)
    expect(isSupportedName('._IMG_1.HEIC')).toBe(false)
    expect(isSupportedName('.DS_Store')).toBe(false)
    expect(isSupportedName('raw.CR2')).toBe(false)
  })
})

describe('resolveOutputFormat', () => {
  it('keeps format by default but swaps read-only inputs', () => {
    expect(resolveOutputFormat('original', 'png', true)).toBe('png')
    expect(resolveOutputFormat('original', 'heic', false)).toBe('jpeg')
    expect(resolveOutputFormat('original', 'svg', true)).toBe('png')
    expect(resolveOutputFormat('webp', 'heic', false)).toBe('webp')
  })
})

describe('targetSize', () => {
  const r = DEFAULT_SETTINGS.resize
  it('matches the original script: cap height at 1600', () => {
    expect(targetSize(4000, 3000, { ...r, mode: 'maxHeight', height: 1600 })).toEqual({ width: 2133, height: 1600 })
  })
  it('never upscales unless asked', () => {
    expect(targetSize(800, 600, { ...r, mode: 'longEdge', longEdge: 2048 })).toBeNull()
    expect(targetSize(800, 600, { ...r, mode: 'longEdge', longEdge: 1600, allowUpscale: true })).toEqual({ width: 1600, height: 1200 })
  })
  it('fits inside a box', () => {
    expect(targetSize(3000, 3000, { ...r, mode: 'fit', width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1080 })
  })
  it('scales by percent, including up', () => {
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 50 })).toEqual({ width: 500, height: 250 })
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 200 })).toEqual({ width: 2000, height: 1000 })
  })
  it('returns null when nothing changes', () => {
    expect(targetSize(1000, 500, { ...r, mode: 'none' })).toBeNull()
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 100 })).toBeNull()
  })
})

describe('naming', () => {
  const ctx = { original: 'IMG_0042.HEIC', n: 7, width: 2048, height: 1536, format: 'webp', date: new Date(2026, 9, 16) }
  it('renders tokens', () => {
    expect(renderName('{name}', ctx)).toBe('IMG_0042')
    expect(renderName('holiday-{n:3}', ctx)).toBe('holiday-007')
    expect(renderName('{date}_{n}_{w}x{h}.{fmt}', ctx)).toBe('2026-10-16_7_2048x1536.webp')
    expect(renderName('', ctx)).toBe('IMG_0042')
  })
  it('sanitises path characters', () => {
    expect(sanitizeName('a/b:c*?')).toBe('a-b-c--')
    expect(sanitizeName('  ..  ')).toBe('image')
  })
  it('builds output paths, optionally keeping folders', () => {
    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', true, true)).toBe('day1/a.jpg')
    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', true, false)).toBe('trip/day1/a.jpg')
    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', false, true)).toBe('a.jpg')
  })
  it('never hands out the same path twice (the old script could overwrite)', () => {
    const taken = new Set<string>()
    expect(reservePath('a.png', taken)).toBe('a.png')
    expect(reservePath('A.png', taken)).toBe('A-2.png')
    expect(reservePath('a.png', taken)).toBe('a-3.png')
  })
})

describe('mergeSettings', () => {
  it('fills in keys missing from older saved settings', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { format: 'avif', quality: { jpeg: 50 } as never })
    expect(merged.format).toBe('avif')
    expect(merged.quality.jpeg).toBe(50)
    expect(merged.quality.webp).toBe(DEFAULT_SETTINGS.quality.webp)
  })
})

const rgba = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4)
  return { data, width: w, height: h }
}

describe('QOI', () => {
  it('round-trips pixels exactly', () => {
    const img = rgba(37, 23, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255, x % 5 === 0 ? 128 : 255])
    const decoded = decodeQoi(encodeQoi(img))
    expect(decoded.width).toBe(37)
    expect(decoded.height).toBe(23)
    expect(Array.from(decoded.data)).toEqual(Array.from(img.data))
  })
  it('handles long runs', () => {
    const img = rgba(300, 2, () => [10, 20, 30, 255])
    expect(Array.from(decodeQoi(encodeQoi(img, 3)).data)).toEqual(Array.from(img.data))
  })
})

describe('BMP', () => {
  it('writes 24-bit bottom-up rows with padding for opaque images', () => {
    const img = rgba(3, 2, (x, y) => [x * 10, y * 10, 99, 255])
    const out = encodeBmp(img)
    const v = new DataView(out.buffer)
    expect(String.fromCharCode(out[0], out[1])).toBe('BM')
    expect(v.getUint16(28, true)).toBe(24)
    const rowSize = 12 // 3px * 3 bytes = 9, padded to 12
    expect(out.length).toBe(54 + rowSize * 2)
    // First stored row is the bottom row (y=1): BGR of pixel (0,1)
    expect([out[54], out[55], out[56]]).toEqual([99, 10, 0])
  })
  it('uses 32-bit with alpha masks when transparent', () => {
    const out = encodeBmp(rgba(2, 2, () => [1, 2, 3, 4]))
    const v = new DataView(out.buffer)
    expect(v.getUint16(28, true)).toBe(32)
    expect(v.getUint32(66, true)).toBe(0xff000000)
  })
})

describe('ICO', () => {
  it('writes a directory pointing at each PNG', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5, 6, 7])
    const out = encodeIco([
      { size: 256, png: b },
      { size: 16, png: a },
    ])
    const v = new DataView(out.buffer)
    expect(v.getUint16(4, true)).toBe(2)
    expect(out[6]).toBe(16)
    expect(out[22]).toBe(0) // 256 is stored as 0
    const off16 = v.getUint32(6 + 12, true)
    expect(Array.from(out.slice(off16, off16 + 3))).toEqual([1, 2, 3])
  })
  it('centres images on a square', () => {
    const img = rgba(2, 1, () => [255, 0, 0, 255])
    const sq = padToSquare(img.data, 2, 1, 4)
    expect(sq[(1 * 4 + 1) * 4 + 3]).toBe(255)
    expect(sq[0 + 3]).toBe(0)
  })
})

/** A JPEG skeleton with an EXIF block: orientation 6, a GPS IFD and a thumbnail link. */
function makeJpegWithExif() {
  const tiff: number[] = []
  const u16 = (n: number) => tiff.push(n & 255, n >> 8)
  const u32 = (n: number) => tiff.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24)
  tiff.push(0x49, 0x49)
  u16(42)
  u32(8)
  // IFD0 @8: 2 entries, then next-IFD pointer
  u16(2)
  u16(0x0112)
  u16(3)
  u32(1)
  u16(6)
  u16(0)
  u16(0x8825)
  u16(4)
  u32(1)
  u32(38)
  u32(100) // pretend IFD1 lives at 100
  // GPS IFD @38: 1 entry, latitude (3 rationals = 24 bytes) at offset 56
  u16(1)
  u16(0x0002)
  u16(5)
  u32(3)
  u32(56)
  u32(0)
  while (tiff.length < 56) tiff.push(0)
  for (let i = 0; i < 24; i++) tiff.push(0xaa)
  const payload = [...'Exif'].map((c) => c.charCodeAt(0)).concat([0, 0], tiff)
  const len = payload.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, 0xff, 0xfe, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9])
}

describe('EXIF', () => {
  it('reads orientation and resets it after re-encoding', () => {
    const seg = extractExifSegment(makeJpegWithExif())!
    expect(seg).not.toBeNull()
    expect(readOrientation(seg)).toBe(6)
    patchExifSegment(seg, { stripGps: false, reencoded: true })
    expect(readOrientation(seg)).toBe(1)
  })

  it('wipes GPS data when asked', () => {
    const seg = extractExifSegment(makeJpegWithExif())!
    patchExifSegment(seg, { stripGps: true, reencoded: false })
    expect(seg.includes(0xaa)).toBe(false)
    expect(readOrientation(seg)).toBe(6) // untouched pixels keep their orientation
  })

  it('strips metadata segments losslessly and can splice one back in', () => {
    const jpeg = makeJpegWithExif()
    const stripped = stripJpegMetadata(jpeg)
    expect(extractExifSegment(stripped)).toBeNull()
    expect(stripped.includes(0xfe)).toBe(false) // comment gone
    expect(Array.from(stripped.slice(-6))).toEqual(Array.from(jpeg.slice(-6))) // scan data intact
    const seg = extractExifSegment(jpeg)!
    const back = insertExifSegment(stripped, seg)
    expect(readOrientation(extractExifSegment(back))).toBe(6)
  })
})

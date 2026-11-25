import { beforeAll, describe, expect, it } from 'vitest'
import UTIF from 'utif2'
import type { ErrorResult, ProcessResult, WorkerRequest, WorkerResponse } from '../../worker/protocol'
import { encodeBmp, hasAlpha } from '../codecs/bmp'
import { encodeIco, padToSquare } from '../codecs/ico'
import { decodeQoi, encodeQoi } from '../codecs/qoi'
import { quantizePixels } from '../codecs/quantize'
import { resizeRgba } from '../codecs/resize'
import { extractExifSegment, insertExifSegment, patchExifSegment, readOrientation, stripJpegMetadata } from '../exif'
import { resolveOutputFormat, sniffFormat } from '../formats'
import { targetSize } from '../resize'
import { DEFAULT_SETTINGS } from '../settings'

const bytes = (...xs: Array<number | string>) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? Array.from(x, (c) => c.charCodeAt(0)) : [x])))

const ftyp = (major: string, ...compat: Array<string>) => {
  const size = 16 + compat.length * 4
  return bytes(0, 0, 0, size, 'ftyp', major, 0, 0, 0, 0, ...compat)
}

const qoiHeader = (w: number) => [...bytes('qoif'), 0, 0, 0, w, 0, 0, 0, 1, 4, 0]
const qoiEnd = [0, 0, 0, 0, 0, 0, 0, 1]

const rgba = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { data.set(fn(x, y), (y * w + x) * 4) }
  }
  return { data, width: w, height: h }
}

class NodeImageData {
  readonly data: Uint8ClampedArray<ArrayBuffer>
  readonly width: number
  readonly height: number
  constructor(a: Uint8ClampedArray<ArrayBuffer> | number, b: number, c?: number) {
    if (typeof a === 'number') {
      this.width = a
      this.height = b
      this.data = new Uint8ClampedArray(new ArrayBuffer(a * b * 4))
    } else {
      this.data = a
      this.width = b
      this.height = c ?? a.length / 4 / b
    }
  }
}

let workerOnMessage: ((event: MessageEvent<WorkerRequest>) => Promise<void>) | null = null
let posted: Array<WorkerResponse> = []

async function dispatchWorker(req: WorkerRequest): Promise<WorkerResponse> {
  if (!workerOnMessage) { throw new Error('Worker harness not initialised') }
  posted = []
  await workerOnMessage({ data: req } as MessageEvent<WorkerRequest>)
  const reply = posted.at(-1)
  if (!reply) { throw new Error('Worker did not post a response') }
  return reply
}

async function dispatchDone(req: WorkerRequest): Promise<ProcessResult> {
  const reply = await dispatchWorker(req)
  if (reply.type !== 'done') { throw new Error(`Expected done response, got ${reply.type}`) }
  return reply
}

async function dispatchError(req: WorkerRequest): Promise<ErrorResult> {
  const reply = await dispatchWorker(req)
  if (reply.type !== 'error') { throw new Error(`Expected error response, got ${reply.type}`) }
  return reply
}

function makeJpegWithExif() {
  const tiff: Array<number> = []
  const u16 = (n: number) => tiff.push(n & 255, n >> 8)
  const u32 = (n: number) => tiff.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24)
  tiff.push(0x49, 0x49)
  u16(42)
  u32(8)
  u16(2)
  u16(0x01_12)
  u16(3)
  u32(1)
  u16(6)
  u16(0)
  u16(0x88_25)
  u16(4)
  u32(1)
  u32(38)
  u32(100)
  u16(1)
  u16(0x00_02)
  u16(5)
  u32(3)
  u32(56)
  u32(0)
  while (tiff.length < 56) { tiff.push(0) }
  for (let i = 0; i < 24; i++) { tiff.push(0xaa) }
  const payload = Array.from('Exif', (c) => c.charCodeAt(0)).concat([0, 0], tiff)
  const len = payload.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...payload, 0xff, 0xfe, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9])
}

describe('conversion worker pipeline', () => {
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>
    if (!g.ImageData) { g.ImageData = NodeImageData }
    g.self = globalThis
    g.postMessage = (msg: WorkerResponse) => { posted.push(msg) }
    await import('../../worker/processor.worker')
    workerOnMessage = (g.self as { onmessage: (e: MessageEvent<WorkerRequest>) => Promise<void> }).onmessage
  })

  it('decodes, resizes, and encodes across formats with intact pixels', async () => {
    const src = rgba(16, 12, () => [120, 80, 200, 255])
    const qoi = encodeQoi(src, 3)
    const res = await dispatchDone({
      type: 'process',
      id: 1,
      file: new Blob([qoi.slice()], { type: 'image/qoi' }),
      name: 'photo.qoi',
      settings: {
        ...DEFAULT_SETTINGS,
        format: 'tiff',
        resize: { ...DEFAULT_SETTINGS.resize, mode: 'maxWidth', width: 8 },
      },
    })

    expect(res.inputFormat).toBe('qoi')
    expect(res.format).toBe('tiff')
    expect(res.sourceWidth).toBe(16)
    expect(res.sourceHeight).toBe(12)
    expect(res.width).toBe(8)
    expect(res.height).toBe(6)
    expect(res.keptOriginal).toBe(false)

    const ifds = UTIF.decode(res.bytes)
    UTIF.decodeImage(res.bytes, ifds[0])
    const decoded = UTIF.toRGBA8(ifds[0])
    expect(ifds[0].width).toBe(8)
    expect(ifds[0].height).toBe(6)
    expect(Math.abs(decoded[0] - 120)).toBeLessThanOrEqual(1)
    expect(Math.abs(decoded[1] - 80)).toBeLessThanOrEqual(1)
    expect(Math.abs(decoded[2] - 200)).toBeLessThanOrEqual(1)
    expect(decoded[3]).toBe(255)
  })

  it('converts transparent images to GIF and 32-bit BMP', async () => {
    const src = rgba(12, 12, (x) => (x < 6 ? [0, 0, 0, 0] : [20, 180, 90, 255]))
    const qoi = encodeQoi(src, 4)

    const gif = await dispatchDone({
      type: 'process',
      id: 2,
      file: new Blob([qoi.slice()], { type: 'image/qoi' }),
      name: 'badge.qoi',
      settings: { ...DEFAULT_SETTINGS, format: 'gif' },
    })
    expect(sniffFormat(new Uint8Array(gif.bytes))).toBe('gif')

    const bmp = await dispatchDone({
      type: 'process',
      id: 3,
      file: new Blob([qoi.slice()], { type: 'image/qoi' }),
      name: 'badge.qoi',
      settings: { ...DEFAULT_SETTINGS, format: 'bmp' },
    })
    const out = new Uint8Array(bmp.bytes)
    expect(sniffFormat(out)).toBe('bmp')
    expect(new DataView(out.buffer).getUint16(28, true)).toBe(32)
  })

  it('keeps original bytes when re-encoding the same format is not smaller, unless forced', async () => {
    const src = rgba(16, 16, (x, y) => [(x * 13) & 255, (y * 17) & 255, 90, 255])
    const qoi = encodeQoi(src, 3)

    const kept = await dispatchDone({
      type: 'process',
      id: 4,
      file: new Blob([qoi.slice()], { type: 'image/qoi' }),
      name: 'same.qoi',
      settings: { ...DEFAULT_SETTINGS, format: 'original', output: { ...DEFAULT_SETTINGS.output, skipIfLarger: true } },
    })
    expect(kept.keptOriginal).toBe(true)
    expect(new Uint8Array(kept.bytes)).toEqual(qoi)

    const forced = await dispatchDone({
      type: 'process',
      id: 5,
      file: new Blob([qoi.slice()], { type: 'image/qoi' }),
      name: 'same.qoi',
      settings: { ...DEFAULT_SETTINGS, format: 'original', output: { ...DEFAULT_SETTINGS.output, skipIfLarger: false } },
    })
    expect(forced.keptOriginal).toBe(false)
  })

  it('returns a worker error for unrecognised input bytes', async () => {
    const res = await dispatchError({
      type: 'process',
      id: 6,
      file: new Blob([new Uint8Array([1, 2, 3, 4])]),
      name: 'unknown.bin',
      settings: DEFAULT_SETTINGS,
    })
    expect(res.message).toMatch(/Unrecognised/i)
  })
})

describe('format detection and output resolution', () => {
  it('sniffs magic bytes, AVIF vs HEIC ftyp brands, SVG, and extension fallback', () => {
    expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.png')).toBe('jpeg')
    expect(sniffFormat(bytes(0x89, 'PNG'))).toBe('png')
    expect(sniffFormat(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp')
    expect(sniffFormat(bytes('GIF89a'))).toBe('gif')
    expect(sniffFormat(bytes('II', 0x2a, 0))).toBe('tiff')
    expect(sniffFormat(bytes('qoif'))).toBe('qoi')
    expect(sniffFormat(bytes(0xff, 0x0a))).toBe('jxl')
    expect(sniffFormat(bytes(0, 0, 1, 0, 1, 0))).toBe('ico')
    expect(sniffFormat(ftyp('heic', 'mif1', 'heic'))).toBe('heic')
    expect(sniffFormat(ftyp('avif', 'mif1', 'avif'))).toBe('avif')
    expect(sniffFormat(ftyp('mif1', 'avif', 'miaf'))).toBe('avif')
    expect(sniffFormat(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'))).toBe('svg')
    expect(sniffFormat(bytes(1, 2, 3), 'photo.HEIC')).toBe('heic')
    expect(sniffFormat(bytes(1, 2, 3), 'notes.txt')).toBeNull()
  })

  it('resolves original format and swaps read-only inputs', () => {
    expect(resolveOutputFormat('original', 'png', true)).toBe('png')
    expect(resolveOutputFormat('original', 'heic', false)).toBe('jpeg')
    expect(resolveOutputFormat('original', 'svg', true)).toBe('png')
    expect(resolveOutputFormat('webp', 'heic', false)).toBe('webp')
  })
})

describe('resize and pixel stages', () => {
  const r = DEFAULT_SETTINGS.resize

  it('computes target dimensions and never upscales unless requested', () => {
    expect(targetSize(4000, 3000, { ...r, mode: 'maxHeight', height: 1600 })).toEqual({ width: 2133, height: 1600 })
    expect(targetSize(3000, 3000, { ...r, mode: 'fit', width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1080 })
    expect(targetSize(800, 600, { ...r, mode: 'longEdge', longEdge: 2048 })).toBeNull()
    expect(targetSize(800, 600, { ...r, mode: 'longEdge', longEdge: 1600, allowUpscale: true })).toEqual({ width: 1600, height: 1200 })
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 50 })).toEqual({ width: 500, height: 250 })
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 200 })).toEqual({ width: 2000, height: 1000 })
    expect(targetSize(1000, 500, { ...r, mode: 'percent', percent: 100 })).toBeNull()
    expect(targetSize(1000, 500, { ...r, mode: 'none' })).toBeNull()
  })

  it('resizes opaque and transparent pixels across all filter methods', () => {
    const flat = rgba(32, 24, () => [120, 60, 200, 255])
    for (const method of ['lanczos3', 'mitchell', 'catrom', 'triangle'] as const) {
      const out = resizeRgba(flat, 15, 11, method, false)
      expect(out.length).toBe(15 * 11 * 4)
      for (let i = 0; i < out.length; i += 4) {
        expect(Math.abs(out[i] - 120)).toBeLessThanOrEqual(1)
        expect(Math.abs(out[i + 1] - 60)).toBeLessThanOrEqual(1)
        expect(Math.abs(out[i + 2] - 200)).toBeLessThanOrEqual(1)
        expect(out[i + 3]).toBe(255)
      }
    }

    const alphaImg = rgba(20, 20, (x) => (x < 10 ? [255, 0, 0, 0] : [0, 200, 50, 255]))
    const resizedAlpha = resizeRgba(alphaImg, 10, 10, 'lanczos3', true)
    expect(resizedAlpha[3]).toBe(0)
    expect(resizedAlpha[(5 * 10 + 9) * 4 + 3]).toBe(255)
    expect(resizedAlpha[(5 * 10 + 9) * 4 + 1]).toBeGreaterThan(190)

    const greyEdge = rgba(8, 1, (x) => [128, 128, 128, x < 4 ? 0 : 255])
    for (const method of ['lanczos3', 'mitchell', 'catrom', 'triangle'] as const) {
      const out = resizeRgba(greyEdge, 32, 1, method, true)
      let brightest = 0
      for (let i = 0; i < out.length; i += 4) {
        if (out[i + 3] > 0) { brightest = Math.max(brightest, out[i], out[i + 1], out[i + 2]) }
      }
      expect(brightest, method).toBeLessThanOrEqual(128)
    }
  })

  it('detects alpha and quantises palettes for GIF 1-bit alpha and PNG full alpha', () => {
    expect(hasAlpha(rgba(17, 13, () => [10, 20, 30, 255]))).toBe(false)
    expect(hasAlpha(rgba(17, 13, (x, y) => [10, 20, 30, x === 16 && y === 12 ? 254 : 255]))).toBe(true)

    const multi = rgba(64, 64, (x, y) => [x * 4, y * 4, ((x + y) * 2) & 255, 255])
    const opaqueRes = quantizePixels(multi.data, 32, { alpha: false, oneBitAlpha: false })
    expect(opaqueRes.palette.length).toBeLessThanOrEqual(32)
    expect(opaqueRes.transparentIndex).toBe(-1)
    for (const idx of opaqueRes.index) { expect(idx).toBeLessThan(opaqueRes.palette.length) }

    const alphaImg = rgba(32, 32, (x, y) => (x < 16 ? [0, 0, 0, 0] : [x * 8, y * 8, 120, y < 16 ? 180 : 255]))
    const gifRes = quantizePixels(alphaImg.data, 16, { alpha: true, oneBitAlpha: true })
    expect(gifRes.transparentIndex).toBe(0)
    expect(gifRes.palette[0]).toEqual([0, 0, 0, 0])
    expect(gifRes.index[0]).toBe(0)

    const pngRes = quantizePixels(alphaImg.data, 16, { alpha: true, oneBitAlpha: false })
    expect(pngRes.palette.length).toBeLessThanOrEqual(16)
    expect(pngRes.palette.some((c) => (c[3] ?? 255) < 255 && (c[3] ?? 255) > 0)).toBe(true)
  })
})

describe('custom binary codecs', () => {
  it('round-trips QOI pixels with alpha and long runs exactly', () => {
    const img = rgba(37, 23, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255, x % 5 === 0 ? 128 : 255])
    const decoded = decodeQoi(encodeQoi(img))
    expect(decoded.width).toBe(37)
    expect(decoded.height).toBe(23)
    expect(Array.from(decoded.data)).toEqual(Array.from(img.data))

    const runImg = rgba(300, 2, () => [10, 20, 30, 255])
    expect(Array.from(decodeQoi(encodeQoi(runImg, 3)).data)).toEqual(Array.from(runImg.data))

    const runThenIndex = decodeQoi(new Uint8Array([...qoiHeader(3), 0xc0, 0xfe, 255, 0, 0, 53, ...qoiEnd]))
    expect(Array.from(runThenIndex.data)).toEqual([0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255])
    expect(() => decodeQoi(new Uint8Array([...qoiHeader(1), 0xff, 1, 2, ...qoiEnd]))).toThrow(/Truncated/)
  })

  it('encodes 24-bit opaque and 32-bit transparent BMP, and packs multi-size ICO', () => {
    const bmp24 = encodeBmp(rgba(3, 2, (x, y) => [x * 10, y * 10, 99, 255]))
    expect(sniffFormat(bmp24)).toBe('bmp')
    expect(new DataView(bmp24.buffer).getUint16(28, true)).toBe(24)
    expect(bmp24.length).toBe(54 + 12 * 2)
    expect(Array.from(bmp24.slice(54, 57))).toEqual([99, 10, 0])
    expect(Array.from(bmp24.slice(66, 69))).toEqual([99, 0, 0])

    const bmp32 = encodeBmp(rgba(2, 2, () => [1, 2, 3, 4]))
    expect(new DataView(bmp32.buffer).getUint16(28, true)).toBe(32)
    expect(new DataView(bmp32.buffer).getUint32(66, true)).toBe(0xff_00_00_00)

    const ico = encodeIco([
      { size: 256, png: new Uint8Array([4, 5, 6, 7]) },
      { size: 16, png: new Uint8Array([1, 2, 3]) },
    ])
    const v = new DataView(ico.buffer)
    expect(sniffFormat(ico)).toBe('ico')
    expect(v.getUint16(4, true)).toBe(2)
    expect(Array.from(ico.slice(v.getUint32(18, true), v.getUint32(18, true) + 3))).toEqual([1, 2, 3])

    const sq = padToSquare(rgba(2, 1, () => [255, 0, 0, 255]).data, 2, 1, 4)
    expect(sq[(1 * 4 + 1) * 4 + 3]).toBe(255)
    expect(sq[3]).toBe(0)
  })
})

describe('EXIF handling', () => {
  it('reads orientation and resets it after re-encoding', () => {
    const seg = extractExifSegment(makeJpegWithExif())!
    expect(readOrientation(seg)).toBe(6)
    patchExifSegment(seg, { stripGps: false, reencoded: true })
    expect(readOrientation(seg)).toBe(1)
  })

  it('wipes GPS data while keeping orientation', () => {
    const seg = extractExifSegment(makeJpegWithExif())!
    patchExifSegment(seg, { stripGps: true, reencoded: false })
    expect(seg.includes(0xaa)).toBe(false)
    expect(readOrientation(seg)).toBe(6)
  })

  it('strips metadata segments losslessly and splices EXIF back in', () => {
    const jpeg = makeJpegWithExif()
    const stripped = stripJpegMetadata(jpeg)
    expect(extractExifSegment(stripped)).toBeNull()
    expect(stripped.includes(0xfe)).toBe(false)
    expect(Array.from(stripped.slice(-6))).toEqual(Array.from(jpeg.slice(-6)))
    const back = insertExifSegment(stripped, extractExifSegment(jpeg)!)
    expect(readOrientation(extractExifSegment(back))).toBe(6)
  })
})

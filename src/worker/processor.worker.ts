import { resolveOutputFormat, sniffFormat } from '../lib/formats'
import { hasAlpha } from '../lib/codecs/bmp'
import { extractExifSegment, insertExifSegment, patchExifSegment, readOrientation, stripJpegMetadata } from '../lib/exif'
import { targetSize } from '../lib/resize'
import { decodeImage } from './decode'
import { encodeImage } from './encode'
import { runGenerate } from './generate'
import { resizeImage } from './resize'
import type { ErrorResult, PreviewRequest, PreviewResult, ProcessRequest, ProcessResult, WorkerRequest } from './protocol'

const OOM_PATTERN = /memory|allocation|out of bounds|aborted\(|array buffer|invalid array length/i
const SNIFF_BYTES = 4096

function keepOriginal(bytes: Uint8Array, isJpeg: boolean, metadata: { keepExif: boolean; stripGps: boolean }): ArrayBuffer {
  if (!isJpeg) { return bytes.buffer as ArrayBuffer }
  let exif: Uint8Array | null = null
  if (metadata.keepExif) {
    exif = extractExifSegment(bytes)
    if (exif) { patchExifSegment(exif, { stripGps: metadata.stripGps, reencoded: false }) }
  }
  return stripJpegMetadata(bytes, exif).slice().buffer
}

async function run(req: ProcessRequest | PreviewRequest) {
  const started = performance.now()
  const { settings } = req

  let fullBuffer: ArrayBuffer | null = null
  let fullBytes: Uint8Array | null = null
  const getFullBuffer = async (): Promise<ArrayBuffer> => {
    if (!fullBuffer) {
      fullBuffer = await req.file.arrayBuffer()
      fullBytes = new Uint8Array(fullBuffer)
    }
    return fullBuffer
  }
  const getFullBytes = async (): Promise<Uint8Array> => {
    if (!fullBytes) {
      const buf = await getFullBuffer()
      fullBytes = new Uint8Array(buf)
    }
    return fullBytes
  }

  let headBytes: Uint8Array
  if (req.file.size <= SNIFF_BYTES) {
    headBytes = await getFullBytes()
  } else {
    headBytes = new Uint8Array(await req.file.slice(0, SNIFF_BYTES).arrayBuffer())
  }
  const inputFormat = sniffFormat(headBytes, req.name)
  if (!inputFormat) { throw new Error('Unrecognised image format') }

  const raster = req.raster
  const decodeSource = raster ?? req.file
  const decodeBuffer = raster ? () => raster.arrayBuffer() : getFullBuffer
  let img = await decodeImage(raster ? 'png' : inputFormat, decodeSource, decodeBuffer)
  const sourceWidth = img.width
  const sourceHeight = img.height
  const before = req.type === 'preview' ? await createImageBitmap(img) : null

  const knownOpaqueInput = inputFormat === 'jpeg'
  let alpha: boolean | undefined = knownOpaqueInput ? false : undefined
  const getAlpha = () => {
    if (alpha === undefined) { alpha = hasAlpha(img) }
    return alpha
  }

  const format = resolveOutputFormat(settings.format, inputFormat, false)

  if (format !== 'ico' && !req.raster) {
    const size = targetSize(img.width, img.height, settings.resize)
    if (size) { img = await resizeImage(img, size.width, size.height, settings.resize.method, getAlpha()) }
  }

  const mtThreads = req.type === 'preview' ? Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)) : req.mtThreads
  let out = await encodeImage(format, img, settings, { alpha, mtThreads })

  if (settings.metadata.keepExif && inputFormat === 'jpeg' && format === 'jpeg') {
    const segment = extractExifSegment(await getFullBytes())
    if (segment) {
      patchExifSegment(segment, {
        width: img.width,
        height: img.height,
        stripGps: settings.metadata.stripGps,
        reencoded: true,
      })
      out = insertExifSegment(out, segment)
    }
  }

  const unchangedSize = img.width === sourceWidth && img.height === sourceHeight
  let keptOriginal = false
  if (
    req.type === 'process' &&
    settings.output.skipIfLarger &&
    format === inputFormat &&
    unchangedSize &&
    out.byteLength >= req.file.size
  ) {
    // WARNING: a rotated JPEG can't drop its EXIF without turning sideways, so it must be re-encoded.
    const rotatedJpeg =
      inputFormat === 'jpeg' &&
      !settings.metadata.keepExif &&
      readOrientation(extractExifSegment(await getFullBytes())) !== 1
    keptOriginal = !rotatedJpeg
  }

  const meta = {
    id: req.id,
    format,
    inputFormat,
    width: format === 'ico' ? Math.max(...settings.ico.sizes) : img.width,
    height: format === 'ico' ? Math.max(...settings.ico.sizes) : img.height,
    sourceWidth,
    sourceHeight,
    keptOriginal,
    ms: performance.now() - started,
  }

  if (req.type === 'preview') {
    if (!before) { throw new Error('Preview is missing its source bitmap') }
    let after: ImageBitmap
    try {
      const decoded = await decodeImage(format, new Blob([out as Uint8Array<ArrayBuffer>]), out.buffer as ArrayBuffer)
      after = await createImageBitmap(decoded)
    } catch {
      after = await createImageBitmap(img)
    }
    const result: PreviewResult = { ...meta, type: 'preview', size: out.byteLength, before, after }
    postMessage(result, { transfer: [result.before, result.after] })
    return
  }

  const outBuffer = keptOriginal
    ? keepOriginal(await getFullBytes(), inputFormat === 'jpeg', settings.metadata)
    : out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
      ? (out.buffer as ArrayBuffer)
      : (out.slice().buffer)
  const result: ProcessResult = { ...meta, type: 'done', bytes: outBuffer }
  postMessage(result, { transfer: [outBuffer] })
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.type === 'generate') {
      await runGenerate(req)
    } else {
      await run(req)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: ErrorResult = {
      type: 'error',
      id: req.id,
      message,
      oom: error instanceof RangeError || OOM_PATTERN.test(message),
    }
    postMessage(result)
  }
}

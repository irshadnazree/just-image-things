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
  const buffer = await req.file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const inputFormat = sniffFormat(bytes, req.name)
  if (!inputFormat) { throw new Error('Unrecognised image format') }

  const decodeSource = req.raster ?? req.file
  const decodeBuffer = req.raster ? await req.raster.arrayBuffer() : buffer
  let img = await decodeImage(req.raster ? 'png' : inputFormat, decodeSource, decodeBuffer)
  const sourceWidth = img.width
  const sourceHeight = img.height
  const before = req.type === 'preview' ? await createImageBitmap(img) : null

  const format = resolveOutputFormat(settings.format, inputFormat, hasAlpha(img))
  if (format !== 'ico' && !req.raster) {
    const size = targetSize(img.width, img.height, settings.resize)
    if (size) { img = await resizeImage(img, size.width, size.height, settings.resize.method) }
  }

  let out = await encodeImage(format, img, settings)

  if (settings.metadata.keepExif && inputFormat === 'jpeg' && format === 'jpeg') {
    const segment = extractExifSegment(bytes)
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
  // WARNING: a rotated JPEG can't drop its EXIF without turning sideways, so it must be re-encoded.
  const rotatedJpeg =
    inputFormat === 'jpeg' && !settings.metadata.keepExif && readOrientation(extractExifSegment(bytes)) !== 1
  const keptOriginal =
    settings.output.skipIfLarger &&
    format === inputFormat &&
    unchangedSize &&
    !rotatedJpeg &&
    out.byteLength >= buffer.byteLength &&
    req.type === 'process'

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
    ? keepOriginal(bytes, inputFormat === 'jpeg', settings.metadata)
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

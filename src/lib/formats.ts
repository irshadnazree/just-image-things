export type EncodableFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'avif'
  | 'jxl'
  | 'gif'
  | 'tiff'
  | 'bmp'
  | 'ico'
  | 'qoi'

/** Formats we can read but not write. */
export type DecodeOnlyFormat = 'heic' | 'svg'

export type InputFormat = EncodableFormat | DecodeOnlyFormat

export type LossyFormat = 'jpeg' | 'webp' | 'avif' | 'jxl'

export interface FormatInfo {
  id: EncodableFormat
  label: string
  ext: string
  mime: string
  lossy: boolean
  /** Whether the format can switch to lossless mode. */
  losslessToggle: boolean
  alpha: boolean
  note?: string
}

export const OUTPUT_FORMATS: FormatInfo[] = [
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true, losslessToggle: false, alpha: false },
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', lossy: false, losslessToggle: false, alpha: true },
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true, losslessToggle: true, alpha: true },
  { id: 'avif', label: 'AVIF', ext: 'avif', mime: 'image/avif', lossy: true, losslessToggle: true, alpha: true },
  { id: 'jxl', label: 'JPEG XL', ext: 'jxl', mime: 'image/jxl', lossy: true, losslessToggle: true, alpha: true },
  { id: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif', lossy: false, losslessToggle: false, alpha: true, note: '256 colours, first frame only' },
  { id: 'tiff', label: 'TIFF', ext: 'tiff', mime: 'image/tiff', lossy: false, losslessToggle: false, alpha: true, note: 'Uncompressed' },
  { id: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp', lossy: false, losslessToggle: false, alpha: true, note: 'Uncompressed' },
  { id: 'ico', label: 'ICO', ext: 'ico', mime: 'image/x-icon', lossy: false, losslessToggle: false, alpha: true, note: 'Multi-size icon' },
  { id: 'qoi', label: 'QOI', ext: 'qoi', mime: 'image/qoi', lossy: false, losslessToggle: false, alpha: true },
]

export const FORMAT_BY_ID = Object.fromEntries(OUTPUT_FORMATS.map((f) => [f.id, f])) as Record<
  EncodableFormat,
  FormatInfo
>

export const INPUT_LABELS: Record<InputFormat, string> = {
  ...(Object.fromEntries(OUTPUT_FORMATS.map((f) => [f.id, f.label])) as Record<EncodableFormat, string>),
  heic: 'HEIC',
  svg: 'SVG',
}

const EXTENSION_MAP: Record<string, InputFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  png: 'png',
  apng: 'png',
  webp: 'webp',
  avif: 'avif',
  heic: 'heic',
  heif: 'heic',
  hif: 'heic',
  jxl: 'jxl',
  gif: 'gif',
  tif: 'tiff',
  tiff: 'tiff',
  bmp: 'bmp',
  dib: 'bmp',
  ico: 'ico',
  cur: 'ico',
  qoi: 'qoi',
  svg: 'svg',
}

export const ACCEPT_ATTR = [
  'image/*',
  ...Object.keys(EXTENSION_MAP).map((e) => `.${e}`),
].join(',')

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function formatFromName(name: string): InputFormat | null {
  return EXTENSION_MAP[extensionOf(name)] ?? null
}

/** Files we should never pick up from a folder walk. */
export function isJunkFile(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db'
}

export function isSupportedName(name: string): boolean {
  return !isJunkFile(name) && formatFromName(name) !== null
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = ''
  for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2'])

/** Identify a file by its magic bytes, falling back to the extension. */
export function sniffFormat(bytes: Uint8Array, name = ''): InputFormat | null {
  const b = bytes
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (ascii(b, 0, 4) === 'qoif') return 'qoi'
  if (b[0] === 0xff && b[1] === 0x0a) return 'jxl'
  if (ascii(b, 4, 8) === 'JXL \r\n\x87\n') return 'jxl'
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))
    return 'tiff'
  if (ascii(b, 4, 4) === 'ftyp') {
    const boxSize = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
    const brands = [ascii(b, 8, 4)]
    for (let i = 16; i + 4 <= Math.min(boxSize, b.length); i += 4) brands.push(ascii(b, i, 4))
    if (brands.includes('avif') || brands.includes('avis')) return 'avif'
    if (brands.some((br) => HEIF_BRANDS.has(br))) return 'heic'
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'ico'
  const head = ascii(b, 0, Math.min(b.length, 1024)).toLowerCase()
  if (head.includes('<svg')) return 'svg'
  return name ? formatFromName(name) : null
}

/** Pick the actual encoder for a job. "original" falls back to JPEG/PNG for read-only inputs. */
export function resolveOutputFormat(
  target: EncodableFormat | 'original',
  input: InputFormat,
  hasAlpha: boolean,
): EncodableFormat {
  if (target !== 'original') return target
  if (input === 'heic') return 'jpeg'
  if (input === 'svg') return 'png'
  if (input === 'jpeg' && hasAlpha) return 'png'
  return input
}

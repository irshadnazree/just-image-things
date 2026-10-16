import { stemOf } from './formats'

export interface NameContext {
  /** Original file name, with extension. */
  original: string
  /** 1-based position in the batch, after applying the start offset. */
  n: number
  width: number
  height: number
  format: string
  date: Date
}

export const NAME_TOKENS: { token: string; label: string }[] = [
  { token: '{name}', label: 'original name' },
  { token: '{n}', label: 'number' },
  { token: '{n:3}', label: 'number, padded (001)' },
  { token: '{w}', label: 'width' },
  { token: '{h}', label: 'height' },
  { token: '{date}', label: 'today (YYYY-MM-DD)' },
  { token: '{fmt}', label: 'output format' },
]

// oxlint-disable-next-line no-control-regex -- control characters are exactly what we strip
const INVALID_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g

export function sanitizeName(name: string): string {
  const cleaned = name.replace(INVALID_CHARS, '-').replace(/^[\s.]+|[\s.]+$/g, '')
  return cleaned || 'image'
}

function isoDate(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function renderName(template: string, ctx: NameContext): string {
  const out = (template.trim() || '{name}').replace(/\{(\w+)(?::(\d+))?\}/g, (match, key: string, pad?: string) => {
    switch (key) {
      case 'name':
        return stemOf(ctx.original)
      case 'n':
        return String(ctx.n).padStart(pad ? Number(pad) : 0, '0')
      case 'w':
        return String(ctx.width)
      case 'h':
        return String(ctx.height)
      case 'date':
        return isoDate(ctx.date)
      case 'fmt':
        return ctx.format
      default:
        return match
    }
  })
  return sanitizeName(out)
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash >= 0 ? relPath.slice(0, slash) : ''
}

/**
 * Relative output path for a file. When a whole folder is dropped, its top-level
 * name is dropped too, so `trip/day1/a.heic` lands at `day1/a.jpg`.
 */
export function outputPath(
  relPath: string,
  baseName: string,
  ext: string,
  keepStructure: boolean,
  stripRoot: boolean,
): string {
  let dir = keepStructure ? dirOf(relPath) : ''
  if (dir && stripRoot) {
    const slash = dir.indexOf('/')
    dir = slash >= 0 ? dir.slice(slash + 1) : ''
  }
  return joinPath(dir, `${baseName}.${ext}`)
}

/** Reserve a path, appending -2, -3… when it is already taken. Case-insensitive, like most file systems. */
export function reservePath(path: string, taken: Set<string>): string {
  const dot = path.lastIndexOf('.')
  const base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  let candidate = path
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base}-${i}${ext}`
  taken.add(candidate.toLowerCase())
  return candidate
}

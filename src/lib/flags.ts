import type { EncodableFormat } from './formats.ts'
import { BUILTIN_PRESETS, DEFAULT_SETTINGS, EFFORT_RANGE, ICO_SIZES, mergeSettings } from './settings.ts'
import type { ConflictPolicy, ResizeMethod, Settings } from './settings.ts'

/**
 * The settings vocabulary shared by the CLI (`--long-edge 1600`), link settings
 * (`?long-edge=1600`), the page's agent API and the HTTP API, so one set of names works everywhere.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const STRING_FLAGS = [
  'format',
  'preset',
  'quality',
  'effort',
  'colors',
  'background',
  'ico-sizes',
  'long-edge',
  'max-width',
  'max-height',
  'fit',
  'scale',
  'resize-method',
  'rename',
  'start-at',
  'conflict',
  'workers',
] as const

export const BOOLEAN_FLAGS = [
  'lossless',
  'no-progressive',
  'force-reencode',
  'upscale',
  'keep-exif',
  'keep-gps',
  'flat',
] as const

export type StringFlag = (typeof STRING_FLAGS)[number]
export type BooleanFlag = (typeof BOOLEAN_FLAGS)[number]
export type FlagValues = Partial<Record<StringFlag, string> & Record<BooleanFlag, boolean>>

/** Single-letter forms accepted in URLs, matching the CLI's short options. */
export const SHORT_FLAGS: Record<string, StringFlag> = { f: 'format', q: 'quality', p: 'preset' }

const FORMAT_ALIASES: Record<string, EncodableFormat | 'original'> = {
  jpeg: 'jpeg',
  jpg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  jxl: 'jxl',
  jpegxl: 'jxl',
  gif: 'gif',
  tiff: 'tiff',
  tif: 'tiff',
  bmp: 'bmp',
  ico: 'ico',
  qoi: 'qoi',
  original: 'original',
  keep: 'original',
}

const LOSSY = ['jpeg', 'webp', 'avif', 'jxl'] as const
const LOSSLESS_TOGGLE = ['webp', 'avif', 'jxl'] as const
const EFFORT_FORMATS = ['png', 'webp', 'avif', 'jxl'] as const
const RESIZE_METHODS: Array<ResizeMethod> = ['lanczos3', 'mitchell', 'catrom', 'triangle']
const CONFLICTS: Array<ConflictPolicy> = ['rename', 'overwrite', 'skip']

function int(flag: string, value: string, min: number, max: number): number
function int(flag: string, value: string | undefined, min: number, max: number): number | undefined
function int(flag: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) { return undefined }
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) { throw new UsageError(`--${flag} must be a whole number from ${min} to ${max}, got "${value}"`) }
  return n
}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: ReadonlyArray<T>): T | undefined {
  if (value === undefined) { return undefined }
  if (!(allowed as ReadonlyArray<string>).includes(value)) { throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`) }
  return value as T
}

export interface ApplyFlagsOptions {
  /** Settings to start from. Default: DEFAULT_SETTINGS. A preset flag replaces them (keeping output and workers). */
  base?: Settings
  /** Applied after the preset and before the other flags (the CLI's --config). */
  config?: Partial<Settings>
}

/** Turn flag values into the web app's Settings. Throws UsageError on bad values. */
export function applyFlags(v: FlagValues, { base = DEFAULT_SETTINGS, config }: ApplyFlagsOptions = {}): Settings {
  let settings: Settings = structuredClone(base)
  if (v.preset !== undefined) {
    const preset = BUILTIN_PRESETS.find((p) => p.id === v.preset)
    if (!preset) { throw new UsageError(`Unknown preset "${v.preset}". Choose from ${BUILTIN_PRESETS.map((p) => p.id).join(', ')}.`) }
    settings = { ...mergeSettings(DEFAULT_SETTINGS, structuredClone(preset.settings)), output: settings.output, workers: settings.workers }
  }
  if (config) { settings = mergeSettings(settings, config) }

  if (v.format !== undefined) {
    const format = FORMAT_ALIASES[v.format.toLowerCase()]
    if (!format) { throw new UsageError(`Unknown format "${v.format}". Choose from ${Object.keys(FORMAT_ALIASES).join(', ')}.`) }
    settings.format = format
  }
  const target = settings.format

  const quality = int('quality', v.quality, 0, 100)
  if (quality !== undefined) {
    const formats = target === 'original' ? LOSSY : LOSSY.filter((f) => f === target)
    if (!formats.length) { throw new UsageError(`--quality only applies to ${LOSSY.join(', ')} (or --format original)`) }
    for (const f of formats) { settings.quality[f] = quality }
  }

  if (v.lossless) {
    const formats = target === 'original' ? LOSSLESS_TOGGLE : LOSSLESS_TOGGLE.filter((f) => f === target)
    if (!formats.length) { throw new UsageError(`--lossless only applies to ${LOSSLESS_TOGGLE.join(', ')}`) }
    for (const f of formats) { settings.lossless[f] = true }
  }

  if (v.effort !== undefined) {
    const formats = target === 'original' ? EFFORT_FORMATS : EFFORT_FORMATS.filter((f) => f === target)
    if (!formats.length) { throw new UsageError(`--effort only applies to ${EFFORT_FORMATS.join(', ')}`) }
    for (const f of formats) {
      const { min, max } = EFFORT_RANGE[f]
      const n = Number(v.effort)
      if (!Number.isInteger(n)) { throw new UsageError(`--effort must be a whole number, got "${v.effort}"`) }
      if (target !== 'original' && (n < min || n > max)) { throw new UsageError(`--effort for ${f} must be from ${min} to ${max}`) }
      settings.effort[f] = Math.min(max, Math.max(min, n))
    }
  }

  if (v.colors !== undefined) {
    if (target === 'gif') {
      settings.gif.colors = int('colors', v.colors, 2, 256)
    } else if (target === 'png' || target === 'original') {
      const n = int('colors', v.colors, 0, 256)
      if (n === 1) { throw new UsageError('--colors must be 0 (off) or from 2 to 256') }
      settings.png.colors = n
    } else {
      throw new UsageError('--colors only applies to png and gif')
    }
  }

  if (v.background !== undefined) {
    if (!/^#?[0-9a-f]{6}$/i.test(v.background)) { throw new UsageError(`--background must be a hex colour like #ffffff, got "${v.background}"`) }
    settings.jpeg.background = v.background.startsWith('#') ? v.background : `#${v.background}`
  }
  if (v['no-progressive']) { settings.jpeg.progressive = false }

  if (v['ico-sizes'] !== undefined) {
    const sizes = v['ico-sizes'].split(',').map((s) => Number(s.trim()))
    const bad = sizes.filter((s) => !ICO_SIZES.includes(s))
    if (!sizes.length || bad.length) { throw new UsageError(`--ico-sizes must be a comma list from ${ICO_SIZES.join(', ')}`) }
    settings.ico.sizes = [...new Set(sizes)].sort((a, b) => a - b)
  }

  if (v['force-reencode']) { settings.output.skipIfLarger = false }

  const resizeFlags = (['long-edge', 'max-width', 'max-height', 'fit', 'scale'] as const).filter((f) => v[f] !== undefined)
  if (resizeFlags.length > 1) { throw new UsageError(`Pick one resize option, got --${resizeFlags.join(' and --')}`) }
  const r = settings.resize
  if (v['long-edge'] !== undefined) { Object.assign(r, { mode: 'longEdge', longEdge: int('long-edge', v['long-edge'], 1, 65_535) }) }
  if (v['max-width'] !== undefined) { Object.assign(r, { mode: 'maxWidth', width: int('max-width', v['max-width'], 1, 65_535) }) }
  if (v['max-height'] !== undefined) { Object.assign(r, { mode: 'maxHeight', height: int('max-height', v['max-height'], 1, 65_535) }) }
  if (v.fit !== undefined) {
    const m = /^(\d+)x(\d+)$/i.exec(v.fit)
    if (!m) { throw new UsageError(`--fit must look like 1920x1080, got "${v.fit}"`) }
    Object.assign(r, { mode: 'fit', width: int('fit', m[1], 1, 65_535), height: int('fit', m[2], 1, 65_535) })
  }
  if (v.scale !== undefined) { Object.assign(r, { mode: 'percent', percent: int('scale', v.scale.replace(/%$/, ''), 1, 1000) }) }
  if (v.upscale) { r.allowUpscale = true }
  const method = oneOf('resize-method', v['resize-method'], RESIZE_METHODS)
  if (method) { r.method = method }

  if (v.rename !== undefined) { settings.rename.template = v.rename }
  const startAt = int('start-at', v['start-at'], 0, 1_000_000_000)
  if (startAt !== undefined) { settings.rename.startAt = startAt }

  if (v['keep-exif']) { settings.metadata.keepExif = true }
  if (v['keep-gps']) {
    if (!settings.metadata.keepExif) { throw new UsageError('--keep-gps needs --keep-exif') }
    settings.metadata.stripGps = false
  }

  if (v.flat) { settings.output.keepStructure = false }
  const conflict = oneOf('conflict', v.conflict, CONFLICTS)
  if (conflict) { settings.output.conflict = conflict }
  const workers = int('workers', v.workers, 1, 64)
  if (workers !== undefined) { settings.workers = workers }

  return settings
}

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

/**
 * Read settings flags from URL parameters, e.g. `?f=webp&q=75&long-edge=1600&lossless`.
 * Keys in `ignore` are skipped; anything else unrecognised is returned in `unknown`.
 */
export function flagsFromParams(params: URLSearchParams, ignore: ReadonlyArray<string> = []): { flags: FlagValues; unknown: Array<string> } {
  const flags: FlagValues = {}
  const unknown: Array<string> = []
  for (const [rawKey, value] of params) {
    if (ignore.includes(rawKey)) { continue }
    const key = SHORT_FLAGS[rawKey] ?? rawKey
    if ((STRING_FLAGS as ReadonlyArray<string>).includes(key)) {
      flags[key] = value
    } else if ((BOOLEAN_FLAGS as ReadonlyArray<string>).includes(key)) {
      flags[key as BooleanFlag] = !FALSE_VALUES.has(value.toLowerCase())
    } else {
      unknown.push(rawKey)
    }
  }
  return { flags, unknown }
}

/** Flags as callers write them: `{ f: 'webp', quality: 75, lossless: true }`. */
export type LooseFlags = Record<string, string | number | boolean | undefined>

/** Accept either flag values or a CLI-style string such as `-f webp -q 75 --long-edge 1600`. */
export function flagsFromInput(input: LooseFlags | string): FlagValues {
  if (typeof input !== 'string') {
    const out: FlagValues = {}
    for (const [rawKey, value] of Object.entries(input)) {
      if (value === undefined) { continue }
      const key = SHORT_FLAGS[rawKey] ?? rawKey
      if ((BOOLEAN_FLAGS as ReadonlyArray<string>).includes(key)) {
        out[key as BooleanFlag] = Boolean(value)
      } else if ((STRING_FLAGS as ReadonlyArray<string>).includes(key)) {
        out[key] = String(value)
      } else {
        throw new UsageError(`Unknown setting "${rawKey}". Known: ${[...STRING_FLAGS, ...BOOLEAN_FLAGS].join(', ')}`)
      }
    }
    return out
  }
  const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^(["'])(.*)\1$/, '$2')) ?? []
  const out: FlagValues = {}
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const m = /^--?([a-z-]+)(?:=(.*))?$/i.exec(token)
    if (!m) { throw new UsageError(`Expected a flag like --format, got "${token}"`) }
    const key = SHORT_FLAGS[m[1]] ?? m[1]
    if ((BOOLEAN_FLAGS as ReadonlyArray<string>).includes(key)) {
      out[key as BooleanFlag] = m[2] === undefined || !FALSE_VALUES.has(m[2])
    } else if ((STRING_FLAGS as ReadonlyArray<string>).includes(key)) {
      const value = m[2] ?? tokens[++i]
      if (value === undefined) { throw new UsageError(`--${key} needs a value`) }
      out[key] = value
    } else {
      throw new UsageError(`Unknown flag "${token}". Known: ${[...STRING_FLAGS, ...BOOLEAN_FLAGS].map((f) => `--${f}`).join(' ')}`)
    }
  }
  return out
}

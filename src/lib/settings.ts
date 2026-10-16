import type { EncodableFormat, LossyFormat } from './formats'

export type ResizeMode = 'none' | 'maxHeight' | 'maxWidth' | 'longEdge' | 'fit' | 'percent'
export type ResizeMethod = 'lanczos3' | 'mitchell' | 'catrom' | 'triangle'
export type Destination = 'folder' | 'zip' | 'files'
export type ConflictPolicy = 'rename' | 'overwrite' | 'skip'

export interface Settings {
  format: EncodableFormat | 'original'
  quality: Record<LossyFormat, number>
  lossless: { webp: boolean; avif: boolean; jxl: boolean }
  /** Encoder effort, normalised per format (see EFFORT_RANGE). */
  effort: { png: number; webp: number; avif: number; jxl: number }
  jpeg: { progressive: boolean; background: string }
  png: { colors: number }
  gif: { colors: number }
  ico: { sizes: number[] }
  resize: {
    mode: ResizeMode
    width: number
    height: number
    longEdge: number
    percent: number
    allowUpscale: boolean
    method: ResizeMethod
  }
  rename: { template: string; startAt: number }
  metadata: { keepExif: boolean; stripGps: boolean }
  output: {
    destination: Destination
    keepStructure: boolean
    skipIfLarger: boolean
    conflict: ConflictPolicy
  }
  /** 0 = automatic. */
  workers: number
}

export const EFFORT_RANGE: Record<keyof Settings['effort'], { min: number; max: number; hint: string }> = {
  png: { min: 0, max: 6, hint: '0 skips optimisation' },
  webp: { min: 0, max: 6, hint: 'Higher is smaller but slower' },
  avif: { min: 0, max: 10, hint: 'AVIF gets slow above 6' },
  jxl: { min: 1, max: 9, hint: 'Higher is smaller but slower' },
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

export const DEFAULT_SETTINGS: Settings = {
  format: 'webp',
  quality: { jpeg: 82, webp: 80, avif: 60, jxl: 75 },
  lossless: { webp: false, avif: false, jxl: false },
  effort: { png: 2, webp: 4, avif: 4, jxl: 5 },
  jpeg: { progressive: true, background: '#ffffff' },
  png: { colors: 0 },
  gif: { colors: 256 },
  ico: { sizes: [16, 32, 48, 256] },
  resize: {
    mode: 'none',
    width: 1920,
    height: 1600,
    longEdge: 2048,
    percent: 50,
    allowUpscale: false,
    method: 'lanczos3',
  },
  rename: { template: '{name}', startAt: 1 },
  metadata: { keepExif: false, stripGps: true },
  output: { destination: 'zip', keepStructure: true, skipIfLarger: true, conflict: 'rename' },
  workers: 0,
}

export interface Preset {
  id: string
  name: string
  builtin?: boolean
  settings: Partial<Settings>
}

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'web',
    name: 'Web: WebP, 2048px max',
    builtin: true,
    settings: { format: 'webp', resize: { ...DEFAULT_SETTINGS.resize, mode: 'longEdge', longEdge: 2048 } },
  },
  {
    id: 'compress',
    name: 'Compress, keep format',
    builtin: true,
    settings: { format: 'original', resize: { ...DEFAULT_SETTINGS.resize, mode: 'none' } },
  },
  {
    id: 'heic-jpeg',
    name: 'iPhone HEIC to JPEG',
    builtin: true,
    settings: { format: 'jpeg', quality: { ...DEFAULT_SETTINGS.quality, jpeg: 90 }, resize: { ...DEFAULT_SETTINGS.resize, mode: 'none' } },
  },
  {
    id: 'avif',
    name: 'Smallest: AVIF',
    builtin: true,
    settings: { format: 'avif', resize: { ...DEFAULT_SETTINGS.resize, mode: 'none' } },
  },
  {
    id: 'favicon',
    name: 'Favicon (ICO)',
    builtin: true,
    settings: { format: 'ico', ico: { sizes: [16, 32, 48, 64, 128, 256] } },
  },
]

/** Merge stored or preset values over defaults, tolerating missing keys from older versions. */
export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const current = (base as unknown as Record<string, unknown>)[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object') {
      out[key] = { ...current, ...value }
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as unknown as Settings
}

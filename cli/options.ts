import { parseArgs } from 'node:util'
import type { EncodableFormat } from '../src/lib/formats.ts'
import {
  BUILTIN_PRESETS,
  DEFAULT_SETTINGS,
  EFFORT_RANGE,
  ICO_SIZES,
  mergeSettings,
  type ConflictPolicy,
  type ResizeMethod,
  type Settings,
} from '../src/lib/settings.ts'

export const HELP = `just-image-things agent CLI

Batch convert, compress, resize and rename a folder of images using the
just-image-things web app. It builds the site, serves it on 127.0.0.1, runs it
in headless Chrome/Chromium/Edge/Brave and writes results to disk. The output
is byte-for-byte what the website would produce with the same settings.

USAGE
  bun run agent <folder-or-files...> [options]

  Inputs are folders (walked recursively, subfolders kept) and/or image files.
  Originals are never modified.

OUTPUT
  -o, --out <dir>         Output folder. Default: <folder>_processed next to the
                          input folder (or ./images_processed for loose files).
      --flat              Don't recreate subfolders in the output.
      --conflict <mode>   When an output file already exists on disk:
                          rename (default, adds -2, -3…), overwrite, skip.

FORMAT AND QUALITY
  -f, --format <fmt>      webp (default), avif, jpeg, png, jxl, gif, tiff, bmp,
                          ico, qoi, or "original" (keep each file's format;
                          HEIC→JPEG, SVG→PNG).
  -p, --preset <id>       Start from a built-in preset, then apply other flags:
                          ${BUILTIN_PRESETS.map((p) => p.id).join(', ')}.
  -q, --quality <0-100>   Lossy quality (jpeg 82, webp 80, avif 60, jxl 75 by
                          default). With --format original it applies to all.
      --lossless          Lossless WebP / AVIF / JPEG XL.
      --effort <n>        Encoder effort: png 0-6, webp 0-6, avif 0-10, jxl 1-9.
                          Higher is smaller and slower.
      --colors <n>        PNG: reduce to n colours (2-256, 0 = off). GIF: 2-256.
      --background <hex>  JPEG: colour behind transparent pixels (#ffffff).
      --no-progressive    JPEG: baseline instead of progressive.
      --ico-sizes <list>  ICO sizes, e.g. 16,32,48,256 (from ${ICO_SIZES.join(', ')}).
      --force-reencode    Write the re-encoded file even when it is bigger than
                          the original (by default the original is kept).

RESIZE (pick one; never upscales unless --upscale)
      --long-edge <px>    Longest side at most <px>.
      --max-width <px>    Width at most <px>.
      --max-height <px>   Height at most <px>.
      --fit <WxH>         Fit inside a WxH box, e.g. 1920x1080.
      --scale <percent>   Scale by a percentage, e.g. 50.
      --upscale           Allow enlarging smaller images.
      --resize-method <m> lanczos3 (default), mitchell, catrom, triangle.

RENAME
      --rename <template> Output name without extension. Tokens: {name} {n}
                          {n:3} {w} {h} {date} {fmt}. Default: {name}.
      --start-at <n>      First value of {n}. Default: 1.

METADATA
      --keep-exif         Keep EXIF for JPEG→JPEG (stripped by default).
      --keep-gps          With --keep-exif, keep GPS location too.

ADVANCED
  -c, --config <file>     JSON file with any subset of the web app's settings,
                          applied after --preset and before other flags.
      --workers <n>       Parallel workers (default: cores - 1).
      --browser <path>    Chromium-based browser to run (or JIT_BROWSER env).
      --headed            Show the browser window instead of running headless.
      --rebuild           Rebuild the site even if the cached build is fresh.
      --dry-run           List the files and resolved settings, process nothing.
      --json              Print a machine-readable JSON report on stdout.
                          Progress always goes to stderr.
  -h, --help              Show this help.

EXIT CODES
  0 all files processed · 1 some files failed · 2 bad arguments or setup error

EXAMPLES
  bun run agent ~/Pictures/trip -f webp -q 75 --long-edge 2048
  bun run agent ~/Pictures/iphone --preset heic-jpeg -o ~/Desktop/jpegs
  bun run agent shots/ -f avif --rename "{date}-{n:3}" --json
  bun run agent logo.svg -f ico --ico-sizes 16,32,48,256
`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export interface CliOptions {
  inputs: string[]
  out?: string
  settings: Settings
  json: boolean
  dryRun: boolean
  headed: boolean
  rebuild: boolean
  browser?: string
  help: boolean
}

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
const RESIZE_METHODS: ResizeMethod[] = ['lanczos3', 'mitchell', 'catrom', 'triangle']
const CONFLICTS: ConflictPolicy[] = ['rename', 'overwrite', 'skip']

function int(flag: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${flag} must be a whole number from ${min} to ${max}, got "${value}"`)
  return n
}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${value}"`)
  return value as T
}

/** Turn command-line arguments into the web app's Settings plus CLI-only switches. */
export function parseCli(argv: string[], readConfig: (path: string) => unknown = () => ({})): CliOptions {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        flat: { type: 'boolean' },
        conflict: { type: 'string' },
        format: { type: 'string', short: 'f' },
        preset: { type: 'string', short: 'p' },
        quality: { type: 'string', short: 'q' },
        lossless: { type: 'boolean' },
        effort: { type: 'string' },
        colors: { type: 'string' },
        background: { type: 'string' },
        'no-progressive': { type: 'boolean' },
        'ico-sizes': { type: 'string' },
        'force-reencode': { type: 'boolean' },
        'long-edge': { type: 'string' },
        'max-width': { type: 'string' },
        'max-height': { type: 'string' },
        fit: { type: 'string' },
        scale: { type: 'string' },
        upscale: { type: 'boolean' },
        'resize-method': { type: 'string' },
        rename: { type: 'string' },
        'start-at': { type: 'string' },
        'keep-exif': { type: 'boolean' },
        'keep-gps': { type: 'boolean' },
        config: { type: 'string', short: 'c' },
        workers: { type: 'string' },
        browser: { type: 'string' },
        headed: { type: 'boolean' },
        rebuild: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const { values: v, positionals } = parsed
  const base = {
    inputs: positionals,
    out: v.out,
    json: !!v.json,
    dryRun: !!v['dry-run'],
    headed: !!v.headed,
    rebuild: !!v.rebuild,
    browser: v.browser,
    help: !!v.help,
  }
  if (v.help) return { ...base, settings: DEFAULT_SETTINGS }
  if (!positionals.length) throw new UsageError('Give at least one folder or image file. Run with --help for usage.')

  let settings: Settings = structuredClone(DEFAULT_SETTINGS)
  if (v.preset) {
    const preset = BUILTIN_PRESETS.find((p) => p.id === v.preset)
    if (!preset) throw new UsageError(`Unknown preset "${v.preset}". Choose from ${BUILTIN_PRESETS.map((p) => p.id).join(', ')}.`)
    settings = mergeSettings(settings, structuredClone(preset.settings))
  }
  if (v.config) {
    const patch = readConfig(v.config)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UsageError(`--config ${v.config} must contain a JSON object`)
    settings = mergeSettings(settings, patch as Partial<Settings>)
  }

  if (v.format !== undefined) {
    const format = FORMAT_ALIASES[v.format.toLowerCase()]
    if (!format) throw new UsageError(`Unknown format "${v.format}". Choose from ${Object.keys(FORMAT_ALIASES).join(', ')}.`)
    settings.format = format
  }
  const target = settings.format

  const quality = int('quality', v.quality, 0, 100)
  if (quality !== undefined) {
    const formats = target === 'original' ? LOSSY : LOSSY.filter((f) => f === target)
    if (!formats.length) throw new UsageError(`--quality only applies to ${LOSSY.join(', ')} (or --format original)`)
    for (const f of formats) settings.quality[f] = quality
  }

  if (v.lossless) {
    const formats = target === 'original' ? LOSSLESS_TOGGLE : LOSSLESS_TOGGLE.filter((f) => f === target)
    if (!formats.length) throw new UsageError(`--lossless only applies to ${LOSSLESS_TOGGLE.join(', ')}`)
    for (const f of formats) settings.lossless[f] = true
  }

  if (v.effort !== undefined) {
    const formats = target === 'original' ? EFFORT_FORMATS : EFFORT_FORMATS.filter((f) => f === target)
    if (!formats.length) throw new UsageError(`--effort only applies to ${EFFORT_FORMATS.join(', ')}`)
    for (const f of formats) {
      const { min, max } = EFFORT_RANGE[f]
      const n = Number(v.effort)
      if (!Number.isInteger(n)) throw new UsageError(`--effort must be a whole number, got "${v.effort}"`)
      if (target !== 'original' && (n < min || n > max)) throw new UsageError(`--effort for ${f} must be from ${min} to ${max}`)
      settings.effort[f] = Math.min(max, Math.max(min, n))
    }
  }

  if (v.colors !== undefined) {
    if (target === 'gif') settings.gif.colors = int('colors', v.colors, 2, 256)!
    else if (target === 'png' || target === 'original') {
      const n = int('colors', v.colors, 0, 256)!
      if (n === 1) throw new UsageError('--colors must be 0 (off) or from 2 to 256')
      settings.png.colors = n
    } else throw new UsageError('--colors only applies to png and gif')
  }

  if (v.background !== undefined) {
    if (!/^#?[0-9a-f]{6}$/i.test(v.background)) throw new UsageError(`--background must be a hex colour like #ffffff, got "${v.background}"`)
    settings.jpeg.background = v.background.startsWith('#') ? v.background : `#${v.background}`
  }
  if (v['no-progressive']) settings.jpeg.progressive = false

  if (v['ico-sizes'] !== undefined) {
    const sizes = v['ico-sizes'].split(',').map((s) => Number(s.trim()))
    const bad = sizes.filter((s) => !ICO_SIZES.includes(s))
    if (!sizes.length || bad.length) throw new UsageError(`--ico-sizes must be a comma list from ${ICO_SIZES.join(', ')}`)
    settings.ico.sizes = [...new Set(sizes)].sort((a, b) => a - b)
  }

  if (v['force-reencode']) settings.output.skipIfLarger = false

  const resizeFlags = (['long-edge', 'max-width', 'max-height', 'fit', 'scale'] as const).filter((f) => v[f] !== undefined)
  if (resizeFlags.length > 1) throw new UsageError(`Pick one resize option, got --${resizeFlags.join(' and --')}`)
  const r = settings.resize
  if (v['long-edge'] !== undefined) Object.assign(r, { mode: 'longEdge', longEdge: int('long-edge', v['long-edge'], 1, 65535) })
  if (v['max-width'] !== undefined) Object.assign(r, { mode: 'maxWidth', width: int('max-width', v['max-width'], 1, 65535) })
  if (v['max-height'] !== undefined) Object.assign(r, { mode: 'maxHeight', height: int('max-height', v['max-height'], 1, 65535) })
  if (v.fit !== undefined) {
    const m = /^(\d+)x(\d+)$/i.exec(v.fit)
    if (!m) throw new UsageError(`--fit must look like 1920x1080, got "${v.fit}"`)
    Object.assign(r, { mode: 'fit', width: int('fit', m[1], 1, 65535), height: int('fit', m[2], 1, 65535) })
  }
  if (v.scale !== undefined) Object.assign(r, { mode: 'percent', percent: int('scale', v.scale.replace(/%$/, ''), 1, 1000) })
  if (v.upscale) r.allowUpscale = true
  const method = oneOf('resize-method', v['resize-method'], RESIZE_METHODS)
  if (method) r.method = method

  if (v.rename !== undefined) settings.rename.template = v.rename
  const startAt = int('start-at', v['start-at'], 0, 1_000_000_000)
  if (startAt !== undefined) settings.rename.startAt = startAt

  if (v['keep-exif']) settings.metadata.keepExif = true
  if (v['keep-gps']) {
    if (!settings.metadata.keepExif) throw new UsageError('--keep-gps needs --keep-exif')
    settings.metadata.stripGps = false
  }

  if (v.flat) settings.output.keepStructure = false
  const conflict = oneOf('conflict', v.conflict, CONFLICTS)
  if (conflict) settings.output.conflict = conflict
  const workers = int('workers', v.workers, 1, 64)
  if (workers !== undefined) settings.workers = workers

  return { ...base, settings }
}

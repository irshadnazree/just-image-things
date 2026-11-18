import { parseArgs } from 'node:util'
import { applyFlags, BOOLEAN_FLAGS, STRING_FLAGS, UsageError, type FlagValues } from '../src/lib/flags.ts'
import { BUILTIN_PRESETS, DEFAULT_SETTINGS, ICO_SIZES, type Settings } from '../src/lib/settings.ts'

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

export { UsageError }

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

  let config: Partial<Settings> | undefined
  if (v.config) {
    const patch = readConfig(v.config)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UsageError(`--config ${v.config} must contain a JSON object`)
    config = patch as Partial<Settings>
  }
  const flags: FlagValues = {}
  for (const key of STRING_FLAGS) if (v[key] !== undefined) flags[key] = v[key]
  for (const key of BOOLEAN_FLAGS) if (v[key]) flags[key] = true
  const settings = applyFlags(flags, { config })

  return { ...base, settings }
}

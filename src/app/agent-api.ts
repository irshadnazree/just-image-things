import { applyFlags, flagsFromInput, flagsFromParams } from '../lib/flags'
import type { FlagValues, LooseFlags } from '../lib/flags'
import { ACCEPT_ATTR } from '../lib/formats'
import { DEFAULT_SETTINGS } from '../lib/settings'
import type { Settings } from '../lib/settings'
import { filesFromList } from './intake'
import { useStore } from './store'
import type { RunReport } from './store'

/** Unique, stable file input for browser tools: `input#jit-files`. */
export const AGENT_INPUT_ID = 'jit-files'

const RESERVED_PARAMS = ['agent', 'save']

const HELP = `just image things: scripting API (runs locally in WebAssembly, nothing is uploaded)

1. Add files: set local file paths on  input#${AGENT_INPUT_ID}
   (any <input type=file> on the page works too).
2. Run:  await justImageThings.run("-f webp -q 75 --long-edge 1600")
   Returns a JSON RunReport ({ ok, cancelled, saved, total, failed, bytesIn, bytesOut, ms, files }).
   Outputs download individually (save: "files", default for <=10 images) or as one zip
   (save: "zip", default for >10 images).

Settings use the CLI's flag names, as a string or an object
({ format: "webp", quality: 75, "long-edge": 1600 }):
  -f/--format webp|avif|jpeg|png|jxl|gif|tiff|bmp|ico|qoi|original (aliases: jpg, jpegxl, tif, keep)
  -p/--preset web|compress|heic-jpeg|avif|favicon
  -q/--quality 0-100 (defaults jpeg 82, webp 80, avif 60, jxl 75)   --lossless (webp, avif, jxl)
  --effort n (png 0-6, webp 0-6, avif 0-10, jxl 1-9)   --colors n (png 0|2-256, gif 2-256)
  --background #hex   --no-progressive   --ico-sizes 16,24,32,48,64,128,256   --force-reencode
  --long-edge px | --max-width px | --max-height px | --fit WxH | --scale %   --upscale
  --resize-method lanczos3|mitchell|catrom|triangle
  --rename "{name}-{n:3}"  (tokens {name} {n} {n:3} {w} {h} {date} {fmt})   --start-at n
  --keep-exif  --keep-gps  --flat  --conflict rename|overwrite|skip  --workers 1-64
The same names work in the URL: /?f=webp&q=75&long-edge=1600 (applies for this visit only).

Other calls: justImageThings.files(), .clear(), .settings(), .configure(flags), .help
Options for run(flags, { save: "files" | "zip", clear: false }).
WebMCP (navigator.modelContext): convert_images, list_queued_images.
Full docs: /llms.txt and /llms-full.txt · Test image generator: /generate`

interface RunOptions {
  save?: 'files' | 'zip'
  clear?: boolean
}

function settingsFrom(flags: FlagValues): Settings {
  const { output, workers } = useStore.getState().settings
  return applyFlags(flags, { base: { ...DEFAULT_SETTINGS, output, workers } })
}

function configure(flags: LooseFlags | string) {
  useStore.getState().useLinkSettings(settingsFrom(flagsFromInput(flags)))
  return useStore.getState().settings
}

async function run(flags?: LooseFlags | string, opts: RunOptions = {}): Promise<RunReport> {
  if (flags !== undefined) { configure(flags) }
  const store = useStore.getState()
  if (store.running) { throw new Error('A run is already in progress') }
  if (!store.items.length) { throw new Error(`No files queued. Set file paths on input#${AGENT_INPUT_ID} first.`) }
  const save = opts.save ?? (store.items.length > 10 ? 'zip' : 'files')
  const report = await store.start({ save })
  if (!report) { throw new Error('The run did not start') }
  if (opts.clear) { useStore.getState().clear() }
  return report
}

function files() {
  return useStore.getState().items.map((i) => ({ path: i.relPath, size: i.file.size, status: i.status }))
}

function addAgentInput() {
  if (document.getElementById(AGENT_INPUT_ID)) { return }
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = ACCEPT_ATTR
  input.id = AGENT_INPUT_ID
  input.hidden = true
  input.setAttribute('aria-label', 'Add images (for automation)')
  input.addEventListener('change', () => {
    if (input.files) { useStore.getState().addFiles(filesFromList(input.files)) }
    input.value = ''
  })
  document.body.append(input)
}

type ModelContext = {
  registerTool?(tool: {
    name: string
    description: string
    inputSchema: object
    execute(input: Record<string, unknown>): Promise<unknown>
  }): unknown
}

const toolText = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

function registerWebMcp() {
  const mc = (navigator as Navigator & { modelContext?: ModelContext }).modelContext
  if (!mc?.registerTool) { return }
  try {
    mc.registerTool({
      name: 'convert_images',
      description:
        'Convert, compress, resize or rename the images queued on the page (add them with the file input first). ' +
        'Runs locally in the browser. Results are downloaded. Returns a JSON report.',
      inputSchema: {
        type: 'object',
        properties: {
          flags: { type: 'string', description: 'CLI-style settings, e.g. "-f webp -q 75 --long-edge 1600"' },
          save: { type: 'string', enum: ['files', 'zip'] },
        },
      },
      async execute(input) {
        return toolText(await run(typeof input.flags === 'string' ? input.flags : undefined, { save: input.save as RunOptions['save'] }))
      },
    })
    mc.registerTool({
      name: 'list_queued_images',
      description: 'List the images queued on the page.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return toolText(files())
      },
    })
  } catch {
    // WARNING: WebMCP is still a draft API; never let it break the page.
  }
}

/** Apply `?f=webp&q=75…` for this visit. Returns false when the link has no settings. */
export function applyLinkSettings(search: string): boolean {
  const { flags } = flagsFromParams(new URLSearchParams(search), RESERVED_PARAMS)
  if (!Object.keys(flags).length) { return false }
  try {
    useStore.getState().useLinkSettings(settingsFrom(flags))
    return true
  } catch (error) {
    // oxlint-disable-next-line no-console -- the visitor's only sign that the link's settings were ignored
    console.warn(`Ignoring settings in the link: ${error instanceof Error ? error.message : error}`)
    return false
  }
}

export function installAgentApi() {
  applyLinkSettings(location.search)
  const api = {
    version: 1,
    help: HELP,
    run,
    configure,
    files,
    settings: () => useStore.getState().settings,
    clear: () => useStore.getState().clear(),
  }
  Object.defineProperty(window, 'justImageThings', { value: api, configurable: true })
  if (document.body) {
    installPageTools()
  } else {
    document.addEventListener('DOMContentLoaded', installPageTools, { once: true })
  }
}

function installPageTools() {
  addAgentInput()
  registerWebMcp()
}

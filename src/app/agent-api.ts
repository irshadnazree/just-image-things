import { applyFlags, flagsFromInput, flagsFromParams, type FlagValues, type LooseFlags } from '../lib/flags'
import { ACCEPT_ATTR } from '../lib/formats'
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings'
import { filesFromList } from './intake'
import { useStore, type RunReport } from './store'

/**
 * A small scripting surface for AI agents and automation that already drive a browser:
 * settings from the link, `window.justImageThings` and (where supported) WebMCP tools.
 * None of it changes the page for people unless they open a link with settings in it.
 */

/** Unique, stable file input for browser tools: `input#jit-files`. */
export const AGENT_INPUT_ID = 'jit-files'

/** Query keys the page owns for other purposes. */
const RESERVED_PARAMS = ['agent', 'save']

const HELP = `just image things: scripting API (runs locally, nothing is uploaded)

1. Add files: set the paths on the file input  input#${AGENT_INPUT_ID}
   (any <input type=file> on the page works too).
2. Run:  await justImageThings.run("-f webp -q 75 --long-edge 1600")
   Returns a JSON report. Outputs go to the browser's downloads
   (save: "files", one download per image) or one zip (save: "zip").

Settings use the CLI's flag names, as a string or an object
({ format: "webp", quality: 75, "long-edge": 1600 }):
  -f/--format webp|avif|jpeg|png|jxl|gif|tiff|bmp|ico|qoi|original
  -q/--quality 0-100   --lossless   --effort n   --colors n   --background #hex
  --long-edge px | --max-width px | --max-height px | --fit WxH | --scale %   --upscale
  --rename "{name}-{n:3}"  (tokens {name} {n} {n:3} {w} {h} {date} {fmt})   --start-at n
  --keep-exif  --keep-gps  --force-reencode  -p/--preset web|compress|heic-jpeg|avif|favicon
The same names work in the link: /?f=webp&q=75&long-edge=1600 (this visit only).

Other calls: justImageThings.files(), .clear(), .settings(), .configure(flags), .help
Options for run(flags, { save: "files" | "zip", clear: false }).`

interface RunOptions {
  /** files (default for up to 10 images) or zip. */
  save?: 'files' | 'zip'
  /** Empty the queue after the run. Default false. */
  clear?: boolean
}

/** Flags apply over the defaults, not the visitor's saved settings, so a link gives the same result for everyone. Where files go is kept. */
function settingsFrom(flags: FlagValues): Settings {
  const { output, workers } = useStore.getState().settings
  return applyFlags(flags, { base: { ...DEFAULT_SETTINGS, output, workers } })
}

function configure(flags: LooseFlags | string) {
  useStore.getState().useLinkSettings(settingsFrom(flagsFromInput(flags)))
  return useStore.getState().settings
}

async function run(flags?: LooseFlags | string, opts: RunOptions = {}): Promise<RunReport> {
  if (flags !== undefined) configure(flags)
  const store = useStore.getState()
  if (store.running) throw new Error('A run is already in progress')
  if (!store.items.length) throw new Error(`No files queued. Set file paths on input#${AGENT_INPUT_ID} first.`)
  const save = opts.save ?? (store.items.length > 10 ? 'zip' : 'files')
  const report = await store.start({ save })
  if (!report) throw new Error('The run did not start')
  if (opts.clear) useStore.getState().clear()
  return report
}

function files() {
  return useStore.getState().items.map((i) => ({ path: i.relPath, size: i.file.size, status: i.status }))
}

function addAgentInput() {
  if (document.getElementById(AGENT_INPUT_ID)) return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = ACCEPT_ATTR
  input.id = AGENT_INPUT_ID
  input.hidden = true
  input.setAttribute('aria-label', 'Add images (for automation)')
  input.addEventListener('change', () => {
    if (input.files) useStore.getState().addFiles(filesFromList(input.files))
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

/** WebMCP (navigator.modelContext): lets browser agents call the page as tools. */
function registerWebMcp() {
  const mc = (navigator as Navigator & { modelContext?: ModelContext }).modelContext
  if (!mc?.registerTool) return
  const text = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
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
        return text(await run(typeof input.flags === 'string' ? input.flags : undefined, { save: input.save as RunOptions['save'] }))
      },
    })
    mc.registerTool({
      name: 'list_queued_images',
      description: 'List the images queued on the page.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return text(files())
      },
    })
  } catch {
    // The API is still a draft; never let it break the page.
  }
}

/** Apply `?f=webp&q=75…` for this visit. Returns false when the link has no settings. */
export function applyLinkSettings(search: string): boolean {
  const { flags } = flagsFromParams(new URLSearchParams(search), RESERVED_PARAMS)
  if (!Object.keys(flags).length) return false
  try {
    useStore.getState().useLinkSettings(settingsFrom(flags))
    return true
  } catch (err) {
    console.warn(`Ignoring settings in the link: ${err instanceof Error ? err.message : err}`)
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
  const ready = () => {
    addAgentInput()
    registerWebMcp()
  }
  if (document.body) ready()
  else document.addEventListener('DOMContentLoaded', ready, { once: true })
}

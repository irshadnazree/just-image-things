import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EncodableFormat } from '../lib/formats'
import { FORMAT_BY_ID } from '../lib/formats'
import { outputPath, renderName, reservePath } from '../lib/naming'
import { DEFAULT_SETTINGS, mergeSettings, type Preset, type Settings } from '../lib/settings'
import { commonRoot, type IntakeFile } from './intake'
import { CancelledError, WorkerPool, autoWorkerCount } from './pool'
import { FilesSink, FolderSink, ZipSink, ensureWritable, pickOutputFolder, supportsFolderOutput, type Sink } from './sinks'
import { rasterizeSvg } from './svg'

export type ItemStatus = 'idle' | 'queued' | 'processing' | 'done' | 'skipped' | 'error'

export interface Item {
  id: number
  file: File
  relPath: string
  status: ItemStatus
  outSize?: number
  outPath?: string
  outFormat?: EncodableFormat
  width?: number
  height?: number
  kept?: boolean
  error?: string
}

export const runKey = (items: Item[]) => items.map((i) => i.id).join(',')

export interface RunStats {
  total: number
  done: number
  failed: number
  bytesIn: number
  bytesOut: number
  startedAt: number
  finishedAt?: number
  workers: number
  cancelled?: boolean
  /** The settings and items the run used, so the UI can tell when a re-run would differ. */
  settings: Settings
  itemIds: string
}

interface State {
  items: Item[]
  selectedId: number | null
  settings: Settings
  presets: Preset[]
  outputFolder: FileSystemDirectoryHandle | null
  running: boolean
  stats: RunStats | null
  /** Shown once after a run ends, e.g. "Saved to photos_processed.zip". */
  notice: string | null
  /** Phones show the settings as a sheet over the page. */
  settingsOpen: boolean

  addFiles(files: IntakeFile[]): void
  removeItem(id: number): void
  clear(): void
  select(id: number | null): void
  update(fn: (s: Settings) => void): void
  applyPreset(preset: Preset): void
  savePreset(name: string): void
  deletePreset(id: string): void
  chooseFolder(): Promise<void>
  start(): Promise<void>
  setSettingsOpen(open: boolean): void
  cancel(): void
}

let nextId = 1
let activePool: WorkerPool | null = null
let activeSink: Sink | null = null

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Item updates arrive from many workers at once; apply them at most once per frame. */
const pendingPatches = new Map<number, Partial<Item>>()
let flushScheduled = false
function patchItem(id: number, patch: Partial<Item>) {
  pendingPatches.set(id, { ...pendingPatches.get(id), ...patch })
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(flushPatches)
}
function flushPatches() {
  flushScheduled = false
  if (!pendingPatches.size) return
  const patches = new Map(pendingPatches)
  pendingPatches.clear()
  useStore.setState((s) => ({
    items: s.items.map((item) => {
      const p = patches.get(item.id)
      return p ? { ...item, ...p } : item
    }),
  }))
}

function zipName(items: Item[]): string {
  const root = commonRoot(items.map((i) => i.relPath))
  return `${root ?? 'images'}_processed.zip`
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      items: [],
      selectedId: null,
      settings: { ...DEFAULT_SETTINGS, output: { ...DEFAULT_SETTINGS.output, destination: supportsFolderOutput ? 'folder' : 'zip' } },
      presets: [],
      outputFolder: null,
      running: false,
      stats: null,
      notice: null,
      settingsOpen: false,

      setSettingsOpen(open) {
        set({ settingsOpen: open })
      },

      addFiles(files) {
        const { items } = get()
        const seen = new Set(items.map((i) => `${i.relPath}|${i.file.size}|${i.file.lastModified}`))
        const added: Item[] = []
        for (const { file, relPath } of files) {
          const key = `${relPath}|${file.size}|${file.lastModified}`
          if (seen.has(key)) continue
          seen.add(key)
          added.push({ id: nextId++, file, relPath, status: 'idle' })
        }
        if (!added.length) return
        const merged = [...items, ...added].sort((a, b) => collator.compare(a.relPath, b.relPath))
        set({ items: merged, selectedId: get().selectedId ?? added[0].id, notice: null })
      },

      removeItem(id) {
        set((s) => ({
          items: s.items.filter((i) => i.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        }))
      },

      clear() {
        if (get().running) return
        set({ items: [], selectedId: null, stats: null, notice: null })
      },

      select(id) {
        set({ selectedId: id })
      },

      update(fn) {
        const next = structuredClone(get().settings)
        fn(next)
        set({ settings: next })
      },

      applyPreset(preset) {
        // Presets never change where files go.
        const { output, workers } = get().settings
        set({ settings: { ...mergeSettings(DEFAULT_SETTINGS, preset.settings), output, workers } })
      },

      savePreset(name) {
        const { output: _output, workers: _workers, ...rest } = get().settings
        const preset: Preset = { id: crypto.randomUUID(), name, settings: structuredClone(rest) }
        set((s) => ({ presets: [...s.presets, preset] }))
      },

      deletePreset(id) {
        set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }))
      },

      async chooseFolder() {
        try {
          set({ outputFolder: await pickOutputFolder() })
        } catch {
          // Picker dismissed.
        }
      },

      async start() {
        const state = get()
        if (state.running || !state.items.length) return
        const settings = structuredClone(state.settings)
        const items = state.items

        // Pickers need the click's user activation, so they run before anything else is awaited.
        let sink: Sink
        try {
          if (settings.output.destination === 'folder' && supportsFolderOutput) {
            let folder = state.outputFolder
            if (!folder) {
              folder = await pickOutputFolder()
              set({ outputFolder: folder })
            } else if (!(await ensureWritable(folder))) {
              return
            }
            sink = new FolderSink(folder, settings.output.conflict)
          } else if (settings.output.destination === 'files' || items.length === 1) {
            sink = new FilesSink()
          } else {
            sink = await ZipSink.create(zipName(items))
          }
        } catch {
          return // picker dismissed
        }

        const pool = new WorkerPool(settings.workers || autoWorkerCount())
        activePool = pool
        activeSink = sink
        const stats: RunStats = {
          total: items.length,
          done: 0,
          failed: 0,
          bytesIn: 0,
          bytesOut: 0,
          startedAt: performance.now(),
          workers: pool.limit,
          settings: state.settings,
          itemIds: runKey(items),
        }
        pool.onLimitChange = (workers) => set((s) => ({ stats: s.stats && { ...s.stats, workers } }))
        set({
          running: true,
          notice: null,
          stats,
          items: items.map((i) => ({ ...i, status: 'queued', error: undefined, outSize: undefined, outPath: undefined })),
        })

        const taken = new Set<string>()
        const stripRoot = commonRoot(items.map((i) => i.relPath)) !== null
        const date = new Date()
        let cancelled = false
        let nextIndex = 0
        let lastStatsPush = 0

        const pushStats = (force = false) => {
          const now = performance.now()
          if (!force && now - lastStatsPush < 100) return
          lastStatsPush = now
          set({ stats: { ...stats } })
        }

        const processOne = async (item: Item, index: number) => {
          patchItem(item.id, { status: 'processing' })
          try {
            const isSvg = /\.svg$/i.test(item.file.name)
            const raster = isSvg ? await rasterizeSvg(item.file, settings) : undefined
            const res = await pool.run({ type: 'process', id: item.id, file: item.file, name: item.file.name, settings, raster })
            const info = FORMAT_BY_ID[res.format]
            const base = renderName(settings.rename.template, {
              original: item.file.name,
              n: settings.rename.startAt + index,
              width: res.width,
              height: res.height,
              format: info.ext,
              date,
            })
            const path = reservePath(outputPath(item.relPath, base, info.ext, settings.output.keepStructure, stripRoot), taken)
            const size = res.bytes.byteLength
            const outcome = await sink.write(path, res.bytes)
            stats.done += 1
            stats.bytesIn += item.file.size
            stats.bytesOut += outcome.skipped ? item.file.size : size
            patchItem(item.id, {
              status: outcome.skipped ? 'skipped' : 'done',
              outSize: size,
              outPath: outcome.path,
              outFormat: res.format,
              width: res.width,
              height: res.height,
              kept: res.keptOriginal,
              error: outcome.skipped ? 'A file with this name already exists' : undefined,
            })
          } catch (err) {
            if (err instanceof CancelledError || cancelled) {
              patchItem(item.id, { status: 'idle' })
              return
            }
            stats.failed += 1
            patchItem(item.id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
          }
          pushStats()
        }

        const lane = async () => {
          while (!cancelled && nextIndex < items.length) {
            const index = nextIndex++
            await processOne(items[index], index)
          }
        }

        cancelHook = () => {
          cancelled = true
          for (const item of items.slice(nextIndex)) patchItem(item.id, { status: 'idle' })
        }

        // A few extra lanes keep workers fed while the main thread writes output.
        await Promise.all(Array.from({ length: pool.limit + 2 }, lane))
        pool.dispose()
        activePool = null
        cancelHook = null

        let notice: string | null = null
        if (cancelled) {
          sink.abort()
          notice = 'Cancelled.'
        } else {
          try {
            await sink.finish()
            if (sink instanceof ZipSink) notice = `Saved ${zipName(items)}`
            else if (sink instanceof FolderSink) notice = `Saved to folder “${get().outputFolder?.name}”`
          } catch (err) {
            notice = `Couldn't finish writing output: ${err instanceof Error ? err.message : err}`
          }
        }
        activeSink = null
        stats.finishedAt = performance.now()
        stats.cancelled = cancelled
        flushPatches()
        set({ running: false, stats: { ...stats }, notice })
      },

      cancel() {
        cancelHook?.()
        activePool?.cancelAll()
        activeSink?.abort()
      },
    }),
    {
      name: 'just-image-things',
      version: 1,
      partialize: (s) => ({ settings: s.settings, presets: s.presets }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>
        const settings = p.settings ? mergeSettings(current.settings, p.settings) : current.settings
        if (settings.output.destination === 'folder' && !supportsFolderOutput) settings.output.destination = 'zip'
        return { ...current, settings, presets: p.presets ?? [] }
      },
    },
  ),
)

let cancelHook: (() => void) | null = null

/** The last run's stats while the list and settings still match it, so its results are what's on screen. */
export function useFreshStats(): RunStats | null {
  const stats = useStore((s) => s.stats)
  const settings = useStore((s) => s.settings)
  const items = useStore((s) => s.items)
  const running = useStore((s) => s.running)
  if (running || !stats?.finishedAt || stats.cancelled) return null
  if (stats.settings !== settings || stats.itemIds !== runKey(items)) return null
  return stats
}

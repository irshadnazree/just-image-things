import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { EncodableFormat } from '../lib/formats'
import { DEFAULT_SETTINGS, mergeSettings, type Preset, type Settings } from '../lib/settings'
import { runBatch } from './batch'
import { commonRoot, type IntakeFile } from './intake'
import { WorkerPool, autoWorkerCount } from './pool'
import { FilesSink, FolderSink, ZipSink, ensureWritable, pickOutputFolder, supportsFolderOutput, type Sink } from './sinks'

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

export interface RunReport {
  ok: boolean
  cancelled: boolean
  /** Where the results went: individual downloads, a downloaded zip, or a picked folder. */
  saved: { to: 'downloads' | 'zip' | 'folder'; name?: string }
  total: number
  failed: number
  bytesIn: number
  bytesOut: number
  ms: number
  files: {
    input: string
    status: ItemStatus
    output?: string
    format?: EncodableFormat
    width?: number
    height?: number
    size?: number
    keptOriginal?: boolean
    error?: string
  }[]
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
  /**
   * Set while the page uses settings from its link (`?f=webp&q=75`). Those apply to this
   * visit only: `saved` is what stays in storage, so a shared link never overwrites preferences.
   */
  linkSettings: { saved: Settings } | null

  addFiles(files: IntakeFile[]): void
  removeItem(id: number): void
  clear(): void
  select(id: number | null): void
  update(fn: (s: Settings) => void): void
  applyPreset(preset: Preset): void
  savePreset(name: string): void
  deletePreset(id: string): void
  chooseFolder(): Promise<void>
  /** Use these settings for this visit without saving them. */
  useLinkSettings(settings: Settings): void
  /**
   * Run the batch. With `save`, scripted callers skip the folder and save pickers:
   * `files` downloads each image, `zip` downloads one archive.
   */
  start(opts?: { save?: 'files' | 'zip' }): Promise<RunReport | null>
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
      linkSettings: null,

      useLinkSettings(settings) {
        const saved = get().linkSettings?.saved ?? get().settings
        set({ settings, linkSettings: { saved } })
      },

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

      async start(opts = {}) {
        const state = get()
        if (state.running || !state.items.length) return null
        const settings = structuredClone(state.settings)
        const items = state.items

        // Pickers need the click's user activation, so they run before anything else is awaited.
        let sink: Sink
        try {
          if (opts.save === 'files') {
            sink = new FilesSink()
          } else if (opts.save === 'zip') {
            sink = await ZipSink.create(zipName(items), false)
          } else if (settings.output.destination === 'folder' && supportsFolderOutput) {
            let folder = state.outputFolder
            if (!folder) {
              folder = await pickOutputFolder()
              set({ outputFolder: folder })
            } else if (!(await ensureWritable(folder))) {
              return null
            }
            sink = new FolderSink(folder, settings.output.conflict)
          } else if (settings.output.destination === 'files' || items.length === 1) {
            sink = new FilesSink()
          } else {
            sink = await ZipSink.create(zipName(items))
          }
        } catch {
          return null // picker dismissed
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

        let lastStatsPush = 0
        const pushStats = (force = false) => {
          const now = performance.now()
          if (!force && now - lastStatsPush < 100) return
          lastStatsPush = now
          set({ stats: { ...stats } })
        }

        const batch = runBatch(
          items.map((i) => ({ relPath: i.relPath, name: i.file.name, file: i.file })),
          settings,
          pool,
          sink,
          {
            onStart: (index) => patchItem(items[index].id, { status: 'processing' }),
            onDone: (index, out) => {
              const item = items[index]
              stats.done += 1
              stats.bytesIn += item.file.size
              stats.bytesOut += out.skipped ? item.file.size : out.size
              patchItem(item.id, {
                status: out.skipped ? 'skipped' : 'done',
                outSize: out.size,
                outPath: out.path,
                outFormat: out.format,
                width: out.width,
                height: out.height,
                kept: out.kept,
                error: out.skipped ? 'A file with this name already exists' : undefined,
              })
              pushStats()
            },
            onError: (index, message) => {
              stats.failed += 1
              patchItem(items[index].id, { status: 'error', error: message })
              pushStats()
            },
            onCancelled: (index) => patchItem(items[index].id, { status: 'idle' }),
          },
        )
        cancelHook = batch.cancel

        const { cancelled } = await batch.done
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

        const finished = get().items
        return {
          ok: !cancelled && stats.failed === 0,
          cancelled,
          saved:
            sink instanceof ZipSink
              ? { to: 'zip', name: zipName(items) }
              : sink instanceof FolderSink
                ? { to: 'folder', name: get().outputFolder?.name }
                : { to: 'downloads' },
          total: stats.total,
          failed: stats.failed,
          bytesIn: stats.bytesIn,
          bytesOut: stats.bytesOut,
          ms: Math.round(stats.finishedAt - stats.startedAt),
          files: finished.map((i) => ({
            input: i.relPath,
            status: i.status,
            output: i.outPath,
            format: i.outFormat,
            width: i.width,
            height: i.height,
            size: i.outSize,
            keptOriginal: i.kept || undefined,
            error: i.error,
          })),
        }
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
      partialize: (s) => ({ settings: s.linkSettings?.saved ?? s.settings, presets: s.presets }),
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

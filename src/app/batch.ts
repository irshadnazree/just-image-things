import type { EncodableFormat } from '../lib/formats'
import { FORMAT_BY_ID } from '../lib/formats'
import { outputPath, renderName, reservePath } from '../lib/naming'
import type { Settings } from '../lib/settings'
import { commonRoot } from './intake'
import { CancelledError } from './pool'
import type { WorkerPool } from './pool'
import type { Sink } from './sinks'
import { rasterizeSvg } from './svg'

export interface BatchInput {
  /** Path relative to whatever was dropped or picked, e.g. `trip/day1/a.heic`. */
  relPath: string
  /** File name with extension. */
  name: string
  /** The bytes, or a loader so a large batch is read from disk only as workers free up. */
  file: Blob | (() => Promise<Blob>)
  /** Optional byte size hint used to schedule larger images first when `file` is lazy. */
  size?: number
}

export interface BatchOutput {
  path: string
  size: number
  format: EncodableFormat
  width: number
  height: number
  /** The original bytes were kept because re-encoding made the file bigger. */
  kept: boolean
  /** The sink refused the write because the file already exists. */
  skipped: boolean
}

export interface BatchHandlers {
  onStart?(index: number): void
  onDone?(index: number, out: BatchOutput): void
  onError?(index: number, message: string): void
  /** Called for each file that was running or still queued when the batch was cancelled. */
  onCancelled?(index: number): void
}

export interface BatchRun {
  done: Promise<{ cancelled: boolean }>
  cancel: () => void
}

export interface ThreadingEnv {
  /** Whether SharedArrayBuffer-backed multi-threaded WASM can run (cross-origin isolated). */
  canMt: boolean
  cores: number
}

function detectThreadingEnv(): ThreadingEnv {
  return {
    canMt: Boolean(globalThis.crossOriginIsolated) && typeof SharedArrayBuffer !== 'undefined',
    cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
  }
}

/**
 * Pick how many files run at once (`lanes`) and the per-file thread budget (`mtThreads`).
 * The MT AVIF and JPEG XL encoders size their pthread pool from `navigator.hardwareConcurrency`
 * and ignore `mtThreads` (it only switches them on), so at most one of them runs at a time.
 * MT oxipng honours `mtThreads`, so the cores are split between its lanes instead.
 */
export function chooseThreading(
  settings: Settings,
  count: number,
  poolLimit: number,
  env: ThreadingEnv = detectThreadingEnv(),
): { lanes: number; mtThreads: number } {
  const { canMt, cores } = env
  if (canMt && cores >= 2 && count > 0) {
    if ((settings.format === 'avif' || settings.format === 'jxl') && count <= 2) {
      return { lanes: 1, mtThreads: cores }
    }
    if (settings.format === 'png' && settings.effort.png > 0 && count <= 2) {
      const workers = Math.min(poolLimit, count)
      const threads = Math.max(2, Math.floor(cores / workers))
      return { lanes: workers, mtThreads: threads }
    }
  }
  return { lanes: Math.min(Math.max(1, count), poolLimit + 2), mtThreads: 1 }
}

/**
 * Process a batch through a worker pool into a sink. Shared by the UI and agent mode
 * so both name, place and encode files the same way.
 */
export function runBatch(
  inputs: Array<BatchInput>,
  settings: Settings,
  pool: WorkerPool,
  sink: Sink,
  handlers: BatchHandlers = {},
): BatchRun {
  const taken = new Set<string>()
  const stripRoot = commonRoot(inputs.map((i) => i.relPath)) !== null
  const date = new Date()
  let cancelled = false

  const order = inputs.map((input, index) => ({
    index,
    size: input.size ?? (typeof input.file === 'function' ? 0 : input.file.size),
  }))
  order.sort((a, b) => b.size - a.size || a.index - b.index)

  const { lanes, mtThreads } = chooseThreading(settings, inputs.length, pool.limit)
  let nextPos = 0

  const processOne = async (input: BatchInput, index: number) => {
    handlers.onStart?.(index)
    try {
      const file = typeof input.file === 'function' ? await input.file() : input.file
      const isSvg = /\.svg$/i.test(input.name)
      const raster = isSvg ? await rasterizeSvg(file, settings) : undefined
      const res = await pool.run({
        type: 'process',
        id: index,
        file,
        name: input.name,
        settings,
        raster,
        mtThreads,
      })
      const info = FORMAT_BY_ID[res.format]
      const base = renderName(settings.rename.template, {
        original: input.name,
        n: settings.rename.startAt + index,
        width: res.width,
        height: res.height,
        format: info.ext,
        date,
      })
      const path = reservePath(outputPath(input.relPath, base, info.ext, settings.output.keepStructure, stripRoot), taken)
      const size = res.bytes.byteLength
      const outcome = await sink.write(path, res.bytes)
      handlers.onDone?.(index, {
        path: outcome.path,
        size,
        format: res.format,
        width: res.width,
        height: res.height,
        kept: res.keptOriginal,
        skipped: outcome.skipped,
      })
    } catch (error) {
      if (error instanceof CancelledError || cancelled) {
        handlers.onCancelled?.(index)
        return
      }
      handlers.onError?.(index, error instanceof Error ? error.message : String(error))
    }
  }

  const lane = async () => {
    while (!cancelled && nextPos < order.length) {
      const index = order[nextPos++].index
      await processOne(inputs[index], index)
    }
  }

  const done = Promise.all(Array.from({ length: lanes }, lane)).then(() => ({ cancelled }))

  return {
    done,
    cancel() {
      if (cancelled) { return }
      cancelled = true
      for (let i = nextPos; i < order.length; i++) { handlers.onCancelled?.(order[i].index) }
      nextPos = order.length
    },
  }
}

import type { EncodableFormat, InputFormat } from '../lib/formats'
import type { SearchPhase, SearchStatus } from '../lib/generate'
import type { Settings } from '../lib/settings'

export interface ProcessRequest {
  type: 'process'
  id: number
  file: Blob
  name: string
  settings: Settings
  /** Pre-rasterised PNG for SVG input (SVG needs the DOM, which workers lack). */
  raster?: Blob
  /** Hint for multi-threaded WASM codecs (>1 enables MT when cross-origin isolated). */
  mtThreads?: number
}

export interface PreviewRequest extends Omit<ProcessRequest, 'type'> {
  type: 'preview'
}

export interface GenerateRequest {
  type: 'generate'
  id: number
  width: number
  height: number
  complexity: number
  seed: number
  format: EncodableFormat
  lossless: boolean
  targetBytes: number | null
}

export type WorkerRequest = ProcessRequest | PreviewRequest | GenerateRequest

export interface ProcessResult {
  type: 'done'
  id: number
  bytes: ArrayBuffer
  format: EncodableFormat
  inputFormat: InputFormat
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  /** True when the original bytes were kept because re-encoding made the file bigger. */
  keptOriginal: boolean
  ms: number
}

export interface PreviewResult extends Omit<ProcessResult, 'type' | 'bytes'> {
  type: 'preview'
  size: number
  before: ImageBitmap
  after: ImageBitmap
}

export interface GenerateProgressResult {
  type: 'generate-progress'
  id: number
  attempt: number
  maxAttempts: number
  size: number
  quality: number
  complexity: number
  phase: SearchPhase
}

export interface GenerateDoneResult {
  type: 'generate-done'
  id: number
  bytes: ArrayBuffer
  preview: ImageBitmap
  width: number
  height: number
  format: EncodableFormat
  lossless: boolean
  quality: number | null
  complexity: number
  complexityAdjusted: boolean
  status: SearchStatus | 'default'
  attempts: number
  maxAttempts: number
  targetBytes: number | null
  ms: number
}

export interface ErrorResult {
  type: 'error'
  id: number
  message: string
  /** Looks like the worker ran out of memory, so the pool should back off. */
  oom: boolean
}

export type WorkerResponse =
  | ProcessResult
  | PreviewResult
  | GenerateProgressResult
  | GenerateDoneResult
  | ErrorResult

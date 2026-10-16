import type { EncodableFormat, InputFormat } from '../lib/formats'
import type { Settings } from '../lib/settings'

export interface ProcessRequest {
  type: 'process'
  id: number
  file: Blob
  name: string
  settings: Settings
  /** Pre-rasterised PNG for SVG input (SVG needs the DOM, which workers lack). */
  raster?: Blob
}

export interface PreviewRequest extends Omit<ProcessRequest, 'type'> {
  type: 'preview'
}

export type WorkerRequest = ProcessRequest | PreviewRequest

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

export interface ErrorResult {
  type: 'error'
  id: number
  message: string
  /** Looks like the worker ran out of memory, so the pool should back off. */
  oom: boolean
}

export type WorkerResponse = ProcessResult | PreviewResult | ErrorResult

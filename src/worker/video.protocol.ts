import type { ExtractOptions, FrameExportFormat, FrameNumbering, VideoMetadata } from '../lib/video-frames'

export type VideoWorkerRequest =
  | { type: 'open'; id: number; file: File }
  | ({ type: 'extract'; id: number } & ExtractOptions)
  | {
      type: 'render-frame'
      id: number
      sourceTimestamp: number
      format: FrameExportFormat
      quality: number
      forClipboard?: boolean
      forPreview?: boolean
    }
  | {
      type: 'export-frames'
      id: number
      items: Array<{ index: number; frameNumber: number; numbering?: FrameNumbering; sourceTimestamp: number }>
      format: FrameExportFormat
      quality: number
    }
  | { type: 'export-ack'; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'close' }

export interface ExtractedFrameChunk {
  index: number
  frameNumber: number
  numbering?: FrameNumbering
  timestamp: number
  sourceTimestamp: number
  duration: number
  isKeyframe?: boolean
  blob: Blob
}

export type VideoWorkerResponse =
  | { type: 'opened'; id: number; metadata: VideoMetadata }
  | { type: 'unsupported'; id: number; reason: string }
  | {
      type: 'frames-batch'
      id: number
      frames: Array<ExtractedFrameChunk>
      extractedCount: number
      totalEstimate: number | null
    }
  | {
      type: 'extract-done'
      id: number
      totalExtracted: number
      truncated: boolean
      cancelled: boolean
      ms: number
    }
  | {
      type: 'frame-rendered'
      id: number
      blob: Blob
      width: number
      height: number
      timestamp: number
      ms: number
    }
  | { type: 'render-cancelled'; id: number }
  | {
      type: 'export-frame'
      id: number
      index: number
      frameNumber: number
      numbering?: FrameNumbering
      sourceTimestamp: number
      bytes: ArrayBuffer
    }
  | {
      type: 'export-done'
      id: number
      count: number
      cancelled: boolean
      ms: number
    }
  | { type: 'error'; id: number; message: string; decodeFailed?: boolean }

import { sanitizeName } from './naming'

export type SamplingMode = 'all' | 'fps' | 'every-n' | 'keyframes'

export type FrameExportFormat = 'png' | 'webp' | 'jpeg'

export type VideoEngineKind = 'webcodecs' | 'video-element'

export type GridDensity = 'sm' | 'md' | 'lg'

export type FrameNumbering = 'frame' | 'sample'

export interface FrameFormatInfo {
  id: FrameExportFormat
  label: string
  ext: string
  mime: string
  supportsQuality: boolean
}

export const FRAME_EXPORT_FORMATS: Record<FrameExportFormat, FrameFormatInfo> = {
  png: { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', supportsQuality: false },
  webp: { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', supportsQuality: true },
  jpeg: { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', supportsQuality: true },
}

export const FRAME_FORMAT_ORDER: Array<FrameExportFormat> = ['png', 'webp', 'jpeg']

export const FPS_PRESETS: Array<number> = [1, 2, 5, 10, 15, 24, 30]

export const DEFAULT_MAX_FRAMES = 5000

export const MAX_SAFE_MEMORY_ZIP_BYTES = 512 * 1024 * 1024

export const MANY_FILES_WARNING_THRESHOLD = 20

export const VIDEO_ACCEPT_ATTR =
  'video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogv,.ogg,.ts,.mts,.m2ts,.3gp'

const VIDEO_EXTS = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'ogv',
  'ogg',
  'ts',
  'mts',
  'm2ts',
  '3gp',
])

export interface VideoMetadata {
  fileName: string
  fileSize: number
  width: number
  height: number
  duration: number
  firstTimestamp: number
  fps: number | null
  estimatedFrames: number | null
  codec: string | null
  formatName: string | null
  hasAlpha: boolean
  engine: VideoEngineKind
}

export interface FrameRecord {
  index: number
  frameNumber: number
  numbering?: FrameNumbering
  timestamp: number
  sourceTimestamp: number
  duration: number
  isKeyframe?: boolean
  thumbBlob: Blob
  thumbUrl: string
}

export interface ExtractOptions {
  mode: SamplingMode
  fps: number
  everyN: number
  startTime: number
  endTime: number
  thumbMaxWidth: number
  maxFrames: number
}

export function isVideoFile(file: { name: string; type: string }): boolean {
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'avi') { return false }
  if (file.type.startsWith('video/')) { return true }
  return ext !== '' && VIDEO_EXTS.has(ext)
}

/** Format a timestamp in seconds as MM:SS.mmm (or HH:MM:SS.mmm for clips over an hour). */
export function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalMs = Math.round(safe * 1000)
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  const mmm = String(ms).padStart(3, '0')
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`
}

export function formatFrameFilename(
  videoName: string,
  frameNumber: number,
  ext: string,
  maxFrameNumber = 9999,
  numbering: FrameNumbering = 'frame',
): string {
  const dot = videoName.lastIndexOf('.')
  const rawStem = dot > 0 ? videoName.slice(0, dot) : videoName
  const stem = sanitizeName(rawStem) || 'video'
  const digits = Math.max(4, String(Math.max(1, maxFrameNumber)).length)
  const padded = String(Math.max(1, Math.round(frameNumber))).padStart(digits, '0')
  const kind = numbering === 'sample' ? 'sample' : 'frame'
  return `${stem}-${kind}-${padded}.${ext}`
}

export function formatArchiveFilename(videoName: string): string {
  const dot = videoName.lastIndexOf('.')
  const rawStem = dot > 0 ? videoName.slice(0, dot) : videoName
  const stem = sanitizeName(rawStem) || 'video'
  return `${stem}-frames.zip`
}

export function computeThumbnailSize(
  width: number,
  height: number,
  maxWidth = 360,
): { width: number; height: number } {
  const safeW = Math.max(1, Math.round(width))
  const safeH = Math.max(1, Math.round(height))
  if (safeW <= maxWidth) { return { width: safeW, height: safeH } }
  const scale = maxWidth / safeW
  return {
    width: Math.max(1, Math.round(safeW * scale)),
    height: Math.max(1, Math.round(safeH * scale)),
  }
}

export function clampTimeRange(
  start: number,
  end: number,
  duration: number,
): { start: number; end: number } {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const clampedStart = Number.isFinite(start) ? Math.min(Math.max(0, start), safeDuration) : 0
  const rawEnd = Number.isFinite(end) && end > 0 ? Math.min(end, safeDuration) : safeDuration
  return {
    start: clampedStart,
    end: Math.max(clampedStart, rawEnd),
  }
}

export function computeSampleTimestamps(
  startSec: number,
  endSec: number,
  fps: number,
  maxCount = DEFAULT_MAX_FRAMES,
): { timestamps: Array<number>; truncated: boolean } {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 1
  const safeStart = Math.max(0, Number.isFinite(startSec) ? startSec : 0)
  const safeEnd = Math.max(safeStart, Number.isFinite(endSec) ? endSec : safeStart)
  const step = 1 / safeFps
  const timestamps: Array<number> = []
  let truncated = false

  for (let i = 0; ; i++) {
    const t = safeStart + i * step
    if (i > 0 && t > safeEnd + 1e-6) { break }
    if (timestamps.length >= maxCount) {
      truncated = true
      break
    }
    timestamps.push(Math.min(t, safeEnd))
    if (safeEnd <= safeStart) { break }
  }
  return { timestamps, truncated }
}

/** Format a frame or sample display label without guessing source ordinals on VFR clips. */
export function formatFrameLabel(
  frameNumber: number,
  numbering: FrameNumbering = 'frame',
  verbose = false,
): string {
  const n = Math.max(1, Math.round(frameNumber))
  if (numbering === 'sample') {
    return `Sample #${n}`
  }
  return verbose ? `Frame #${n}` : `#${n}`
}

/** Update a multi-selection set with click and Shift+click range semantics. */
export function updateFrameSelection(
  selected: ReadonlySet<number>,
  anchor: number | null,
  target: number,
  shiftKey: boolean,
  orderedIds: ReadonlyArray<number>,
): { next: Set<number>; nextAnchor: number } {
  const next = new Set(selected)
  if (shiftKey && anchor !== null) {
    const startIdx = orderedIds.indexOf(anchor)
    const endIdx = orderedIds.indexOf(target)
    if (startIdx >= 0 && endIdx >= 0) {
      const lo = Math.min(startIdx, endIdx)
      const hi = Math.max(startIdx, endIdx)
      for (let i = lo; i <= hi; i++) {
        next.add(orderedIds[i])
      }
      return { next, nextAnchor: anchor }
    }
  }

  if (next.has(target)) {
    next.delete(target)
  } else {
    next.add(target)
  }
  return { next, nextAnchor: target }
}

export function estimateFrameCount(
  meta: Pick<VideoMetadata, 'duration' | 'fps' | 'estimatedFrames'>,
  mode: SamplingMode,
  fps: number,
  everyN: number,
  startTime: number,
  endTime: number,
): number | null {
  const range = clampTimeRange(startTime, endTime, meta.duration)
  const span = Math.max(0, range.end - range.start)
  if (mode === 'fps') {
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 1
    return Math.max(1, Math.floor(span * safeFps + 1e-6) + 1)
  }
  if (mode === 'keyframes') {
    return null
  }
  const sourceFps =
    meta.fps ?? (meta.estimatedFrames && meta.duration > 0 ? meta.estimatedFrames / meta.duration : null)
  if (!sourceFps) { return null }
  const totalInRange = Math.max(1, Math.round(span * sourceFps))
  if (mode === 'every-n') {
    const stride = Math.max(1, Math.round(everyN))
    return Math.max(1, Math.ceil(totalInRange / stride))
  }
  return totalInRange
}

/** Rough upper-bound byte estimate for non-streaming ZIP memory checks. */
export function estimateExportArchiveBytes(
  width: number,
  height: number,
  count: number,
  format: FrameExportFormat,
): number {
  const pixels = Math.max(1, width) * Math.max(1, height)
  const bytesPerPixel = format === 'png' ? 2.4 : format === 'webp' ? 0.35 : 0.45
  return Math.round(pixels * bytesPerPixel * Math.max(0, count))
}

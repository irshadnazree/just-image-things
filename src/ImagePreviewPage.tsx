import { AppHeader, AppHeaderBadge, Button, ThemeToggle } from '@irshadnazree/just-things-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { handleNavClick } from './app/router'
import {
  FilesSink,
  FolderSink,
  ZipSink,
  ensureWritable,
  pickOutputFolder,
  supportsFolderOutput,
  supportsSavePicker,
  triggerDownload,
} from './app/sinks'
import type { Sink } from './app/sinks'
import { VideoFrameEngine, copyPngToClipboard } from './app/video-engine'
import { FrameGrid } from './components/FrameGrid'
import { FrameLightbox } from './components/FrameLightbox'
import { Field, NumberInput, Section, Segmented, Slider } from './components/controls'
import { formatBytes, formatDuration } from './lib/format-bytes'
import { reservePath } from './lib/naming'
import {
  DEFAULT_MAX_FRAMES,
  FPS_PRESETS,
  FRAME_EXPORT_FORMATS,
  FRAME_FORMAT_ORDER,
  MANY_FILES_WARNING_THRESHOLD,
  MAX_SAFE_MEMORY_ZIP_BYTES,
  VIDEO_ACCEPT_ATTR,
  clampTimeRange,
  estimateExportArchiveBytes,
  formatArchiveFilename,
  formatFrameFilename,
  formatFrameLabel,
  formatTimecode,
  isVideoFile,
  updateFrameSelection,
} from './lib/video-frames'
import type {
  FrameExportFormat,
  FrameRecord,
  GridDensity,
  SamplingMode,
  VideoMetadata,
} from './lib/video-frames'

type ExportDestination = 'zip' | 'folder' | 'files'

const SAMPLING_MODES: Array<{ value: SamplingMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'fps', label: 'FPS' },
  { value: 'every-n', label: 'Every Nth' },
  { value: 'keyframes', label: 'Keyframes' },
]

const DENSITY_OPTIONS: Array<{ value: GridDensity; label: string }> = [
  { value: 'sm', label: 'S' },
  { value: 'md', label: 'M' },
  { value: 'lg', label: 'L' },
]

const INPUT_DEBOUNCE_MS = 400

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default function ImagePreviewPage() {
  const engine = useMemo(() => new VideoFrameEngine(), [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeUrlsRef = useRef<Array<string>>([])
  const staleUrlBatchesRef = useRef<Array<Array<string>>>([])
  const openRunRef = useRef(0)
  const extractRunRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragDepthRef = useRef(0)
  const anchorIndexRef = useRef<number | null>(null)
  const framesRef = useRef<Array<FrameRecord>>([])
  const exportingRef = useRef(false)

  const [meta, setMeta] = useState<VideoMetadata | null>(null)
  const [frames, setFrames] = useState<Array<FrameRecord>>([])
  const [urlEpoch, setUrlEpoch] = useState(0)
  const [opening, setOpening] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractEstimate, setExtractEstimate] = useState<number | null>(null)
  const [extractMs, setExtractMs] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [extractCancelled, setExtractCancelled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmWarningKey, setConfirmWarningKey] = useState<string | null>(null)

  const [mode, setMode] = useState<SamplingMode>('all')
  const [fps, setFps] = useState(2)
  const [everyN, setEveryN] = useState(5)
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(0)
  const [density, setDensity] = useState<GridDensity>('md')

  const [exportFormat, setExportFormat] = useState<FrameExportFormat>('png')
  const [exportQuality, setExportQuality] = useState(92)
  const [destination, setDestination] = useState<ExportDestination>('zip')
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null)

  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [inspectIndex, setInspectIndex] = useState<number | null>(null)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [busyCopyIndex, setBusyCopyIndex] = useState<number | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0 })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    framesRef.current = frames
  }, [frames])

  useEffect(() => {
    exportingRef.current = exporting
  }, [exporting])

  const scheduleRevokeActiveUrls = useCallback(() => {
    if (activeUrlsRef.current.length === 0) { return }
    staleUrlBatchesRef.current.push(activeUrlsRef.current)
    activeUrlsRef.current = []
    setUrlEpoch((n) => n + 1)
  }, [])

  useEffect(() => {
    if (staleUrlBatchesRef.current.length === 0) { return }
    const batches = staleUrlBatchesRef.current
    staleUrlBatchesRef.current = []
    for (const batch of batches) {
      for (const url of batch) {
        URL.revokeObjectURL(url)
      }
    }
  }, [urlEpoch])

  useEffect(
    () => () => {
      if (copyTimerRef.current) { clearTimeout(copyTimerRef.current) }
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current) }
      for (const batch of staleUrlBatchesRef.current) {
        for (const url of batch) { URL.revokeObjectURL(url) }
      }
      for (const url of activeUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
      staleUrlBatchesRef.current = []
      activeUrlsRef.current = []
      engine.dispose()
    },
    [engine],
  )

  useEffect(() => {
    if (!settingsOpen) { return }
    document.documentElement.classList.add('sheet-open')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.documentElement.classList.remove('sheet-open')
      window.removeEventListener('keydown', onKey, true)
    }
  }, [settingsOpen])

  const runExtraction = useCallback(
    async (
      videoMeta: VideoMetadata,
      opts: { mode: SamplingMode; fps: number; everyN: number; startSec: number; endSec: number },
    ) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      const runId = ++extractRunRef.current
      scheduleRevokeActiveUrls()
      setFrames([])
      setSelected(new Set())
      anchorIndexRef.current = null
      setInspectIndex(null)
      setConfirmWarningKey(null)
      setExtracting(true)
      setExtractEstimate(null)
      setExtractMs(null)
      setTruncated(false)
      setExtractCancelled(false)
      setError(null)
      setNotice(null)

      const range = clampTimeRange(opts.startSec, opts.endSec, videoMeta.duration)
      const thumbMaxWidth = typeof window !== 'undefined' && window.devicePixelRatio > 1 ? 480 : 360
      try {
        const result = await engine.extract(
          {
            mode: opts.mode,
            fps: opts.fps,
            everyN: opts.everyN,
            startTime: range.start,
            endTime: range.end,
            thumbMaxWidth,
            maxFrames: DEFAULT_MAX_FRAMES,
          },
          {
            onBatch: (batch) => {
              if (runId !== extractRunRef.current) { return }
              const nextRecords: Array<FrameRecord> = batch.frames.map((chunk) => {
                const thumbUrl = URL.createObjectURL(chunk.blob)
                activeUrlsRef.current.push(thumbUrl)
                return {
                  index: chunk.index,
                  frameNumber: chunk.frameNumber,
                  numbering: chunk.numbering,
                  timestamp: chunk.timestamp,
                  sourceTimestamp: chunk.sourceTimestamp,
                  duration: chunk.duration,
                  isKeyframe: chunk.isKeyframe,
                  thumbBlob: chunk.blob,
                  thumbUrl,
                }
              })
              setExtractEstimate(batch.totalEstimate)
              setFrames((prev) => prev.concat(nextRecords))
            },
            onEngineFallback: (fallbackMeta) => {
              if (runId !== extractRunRef.current) { return }
              setMeta(fallbackMeta)
              setNotice('WebCodecs failed on this codec — switched automatically to browser video decoder.')
            },
          },
        )
        if (runId !== extractRunRef.current) { return }
        setExtracting(false)
        setExtractMs(result.ms)
        setTruncated(result.truncated)
        setExtractCancelled(result.cancelled)
      } catch (error_) {
        if (runId !== extractRunRef.current) { return }
        setExtracting(false)
        if (!isAbortError(error_)) {
          setError(error_ instanceof Error ? error_.message : String(error_))
        }
      }
    },
    [engine, scheduleRevokeActiveUrls],
  )

  const loadVideoFile = useCallback(
    async (file: File) => {
      if (exportingRef.current) {
        setNotice('Wait for the current export to finish before loading another video.')
        return
      }
      if (!isVideoFile(file)) {
        setError(
          file.name.toLowerCase().endsWith('.avi')
            ? `"${file.name}" uses the AVI container, which browsers and WebCodecs cannot decode.`
            : `"${file.name}" does not look like a supported video file.`,
        )
        return
      }
      const openId = ++openRunRef.current
      extractRunRef.current += 1
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      engine.cancelExtraction()
      engine.cancelExport()
      scheduleRevokeActiveUrls()
      setFrames([])
      setSelected(new Set())
      anchorIndexRef.current = null
      setInspectIndex(null)
      setConfirmWarningKey(null)
      setOpening(true)
      setExtracting(false)
      setError(null)
      setNotice(null)
      setTruncated(false)
      setExtractCancelled(false)
      setExtractMs(null)

      try {
        const videoMeta = await engine.open(file)
        if (openId !== openRunRef.current) { return }
        setMeta(videoMeta)
        setStartSec(0)
        setEndSec(Math.round(videoMeta.duration * 100) / 100)
        setOpening(false)
        void runExtraction(videoMeta, {
          mode,
          fps,
          everyN,
          startSec: 0,
          endSec: videoMeta.duration,
        })
      } catch (error_) {
        if (openId !== openRunRef.current) { return }
        setOpening(false)
        if (!isAbortError(error_)) {
          setMeta(null)
          setError(error_ instanceof Error ? error_.message : String(error_))
        }
      }
    },
    [engine, everyN, fps, mode, runExtraction, scheduleRevokeActiveUrls],
  )

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) { return }
      e.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) { return }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = exportingRef.current ? 'none' : 'copy'
      }
    }
    const leave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) { setDragActive(false) }
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) { return }
      e.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)
      if (exportingRef.current) { return }
      const dropped = e.dataTransfer?.files?.[0]
      if (dropped) { void loadVideoFile(dropped) }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [loadVideoFile])

  useEffect(() => {
    if (!meta || inspectIndex !== null || settingsOpen) { return }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) { return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        const currentFrames = framesRef.current
        if (currentFrames.length === 0) { return }
        e.preventDefault()
        setSelected(new Set(currentFrames.map((f) => f.index)))
      } else if (e.key === 'Escape') {
        setSelected((prev) => (prev.size > 0 ? new Set() : prev))
        anchorIndexRef.current = null
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inspectIndex, meta, settingsOpen])

  const triggerReExtract = useCallback(
    (overrides?: Partial<{ mode: SamplingMode; fps: number; everyN: number; startSec: number; endSec: number }>) => {
      if (!meta) { return }
      const next = {
        mode: overrides?.mode ?? mode,
        fps: overrides?.fps ?? fps,
        everyN: overrides?.everyN ?? everyN,
        startSec: overrides?.startSec ?? startSec,
        endSec: overrides?.endSec ?? endSec,
      }
      void runExtraction(meta, next)
    },
    [endSec, everyN, fps, meta, mode, runExtraction, startSec],
  )

  const scheduleReExtract = useCallback(
    (overrides: Partial<{ mode: SamplingMode; fps: number; everyN: number; startSec: number; endSec: number }>) => {
      if (!meta) { return }
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current) }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        triggerReExtract(overrides)
      }, INPUT_DEBOUNCE_MS)
    },
    [meta, triggerReExtract],
  )

  const handleModeChange = (nextMode: SamplingMode) => {
    setMode(nextMode)
    triggerReExtract({ mode: nextMode })
  }

  const handleFpsPresetClick = (preset: number) => {
    setFps(preset)
    if (mode === 'fps') { triggerReExtract({ mode: 'fps', fps: preset }) }
  }

  const handleFpsInputChange = (nextFps: number) => {
    setFps(nextFps)
    if (mode === 'fps') { scheduleReExtract({ mode: 'fps', fps: nextFps }) }
  }

  const handleEveryNChange = (nextEveryN: number) => {
    setEveryN(nextEveryN)
    if (mode === 'every-n') { scheduleReExtract({ mode: 'every-n', everyN: nextEveryN }) }
  }

  const handleStopExtract = () => {
    engine.cancelExtraction()
  }

  const orderedIds = useMemo(() => frames.map((f) => f.index), [frames])

  const maxFrameNumber = useMemo(() => {
    let max = frames.length
    for (const f of frames) {
      if (f.frameNumber > max) { max = f.frameNumber }
    }
    return Math.max(1, max)
  }, [frames])

  const handleToggleSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      setConfirmWarningKey(null)
      setSelected((prev) => {
        const { next, nextAnchor } = updateFrameSelection(prev, anchorIndexRef.current, index, shiftKey, orderedIds)
        anchorIndexRef.current = nextAnchor
        return next
      })
    },
    [orderedIds],
  )

  const handleSelectAll = () => {
    setConfirmWarningKey(null)
    setSelected(new Set(orderedIds))
  }

  const handleClearSelection = () => {
    setConfirmWarningKey(null)
    setSelected(new Set())
    anchorIndexRef.current = null
  }

  const handleInvertSelection = () => {
    setConfirmWarningKey(null)
    setSelected((prev) => {
      const next = new Set<number>()
      for (const id of orderedIds) {
        if (!prev.has(id)) { next.add(id) }
      }
      return next
    })
  }

  const handleCopyFrame = useCallback(
    async (frame: FrameRecord) => {
      setBusyCopyIndex(frame.index)
      setNotice(null)
      try {
        await copyPngToClipboard(() =>
          engine.renderFrame(frame.sourceTimestamp, 'png', 100, { forClipboard: true }).then((r) => r.blob),
        )
        setCopiedIndex(frame.index)
        setNotice(
          `Copied ${formatFrameLabel(frame.frameNumber, frame.numbering, true)} (${meta ? `${meta.width}×${meta.height}` : 'full res'}) to clipboard.`,
        )
        if (copyTimerRef.current) { clearTimeout(copyTimerRef.current) }
        copyTimerRef.current = setTimeout(() => setCopiedIndex(null), 1800)
      } catch (error_) {
        setNotice(error_ instanceof Error ? error_.message : 'Failed to copy frame to clipboard.')
      } finally {
        setBusyCopyIndex((prev) => (prev === frame.index ? null : prev))
      }
    },
    [engine, meta],
  )

  const handleDownloadSingle = useCallback(
    async (frame: FrameRecord) => {
      if (!meta) { return }
      setNotice(null)
      try {
        const formatInfo = FRAME_EXPORT_FORMATS[exportFormat]
        const rendered = await engine.renderFrame(frame.sourceTimestamp, exportFormat, exportQuality)
        const name = formatFrameFilename(
          meta.fileName,
          frame.frameNumber,
          formatInfo.ext,
          maxFrameNumber,
          frame.numbering,
        )
        triggerDownload(rendered.blob, name)
        setNotice(`Downloaded ${name}.`)
      } catch (error_) {
        if (!isAbortError(error_)) {
          setNotice(error_ instanceof Error ? error_.message : 'Failed to download frame.')
        }
      }
    },
    [engine, exportFormat, exportQuality, maxFrameNumber, meta],
  )

  const selectedFrames = useMemo(() => {
    if (selected.size === 0) { return [] }
    return frames.filter((f) => selected.has(f.index))
  }, [frames, selected])

  const handleDownloadBatch = async () => {
    if (!meta || frames.length === 0 || exporting) { return }
    const targets = selectedFrames.length > 0 ? selectedFrames : frames
    if (targets.length === 1) {
      await handleDownloadSingle(targets[0])
      return
    }

    const warningKey = `${destination}:${exportFormat}:${targets.length}`
    if (destination === 'zip' && !supportsSavePicker) {
      const estimatedBytes = estimateExportArchiveBytes(meta.width, meta.height, targets.length, exportFormat)
      if (estimatedBytes > MAX_SAFE_MEMORY_ZIP_BYTES && confirmWarningKey !== warningKey) {
        setConfirmWarningKey(warningKey)
        setNotice(
          `Estimated ZIP size (~${formatBytes(estimatedBytes)}) may exceed browser memory without a streaming save picker. Switch to WebP/JPEG${supportsFolderOutput ? ' or Folder' : ''}, select fewer frames, or click Download again to proceed anyway.`,
        )
        return
      }
    }

    if (destination === 'files' && targets.length > MANY_FILES_WARNING_THRESHOLD && confirmWarningKey !== warningKey) {
      setConfirmWarningKey(warningKey)
      setNotice(
        `Downloading ${targets.length} separate files may trigger browser download prompts. Switch to ZIP${supportsFolderOutput ? ' or Folder' : ''}, or click Download again to continue.`,
      )
      return
    }
    setConfirmWarningKey(null)

    const formatInfo = FRAME_EXPORT_FORMATS[exportFormat]
    let sink: Sink
    try {
      if (destination === 'folder' && supportsFolderOutput) {
        const handle = folderHandle ?? (await pickOutputFolder())
        if (!(await ensureWritable(handle))) {
          setNotice('Folder write permission was not granted.')
          return
        }
        setFolderHandle(handle)
        sink = new FolderSink(handle, 'rename')
      } else if (destination === 'files') {
        sink = new FilesSink()
      } else {
        sink = await ZipSink.create(formatArchiveFilename(meta.fileName))
      }
    } catch (error_) {
      if (isAbortError(error_)) { return }
      setNotice(error_ instanceof Error ? error_.message : 'Could not open download destination.')
      return
    }

    setExporting(true)
    setExportProgress({ done: 0, total: targets.length })
    setNotice(null)

    const taken = new Set<string>()
    let written = 0

    try {
      const result = await engine.exportFrames(
        targets.map((f) => ({
          index: f.index,
          frameNumber: f.frameNumber,
          numbering: f.numbering,
          sourceTimestamp: f.sourceTimestamp,
        })),
        exportFormat,
        exportQuality,
        async (item) => {
          const baseName = formatFrameFilename(
            meta.fileName,
            item.frameNumber,
            formatInfo.ext,
            maxFrameNumber,
            item.numbering,
          )
          const uniquePath = reservePath(baseName, taken)
          await sink.write(uniquePath, item.bytes)
          written += 1
          setExportProgress({ done: written, total: targets.length })
        },
      )

      if (result.cancelled) {
        sink.abort()
        setNotice(`Export cancelled after ${written} of ${targets.length} frames.`)
      } else {
        await sink.finish()
        setNotice(
          `Downloaded ${written} ${written === 1 ? 'frame' : 'frames'} as ${formatInfo.label} in ${formatDuration(result.ms)}.`,
        )
      }
    } catch (error_) {
      sink.abort()
      if (!isAbortError(error_)) {
        setNotice(error_ instanceof Error ? error_.message : 'Failed to export frames.')
      }
    } finally {
      setExporting(false)
    }
  }

  const handlePickFolder = async () => {
    try {
      const handle = await pickOutputFolder()
      setFolderHandle(handle)
      setDestination('folder')
      setConfirmWarningKey(null)
    } catch (error_) {
      if (!isAbortError(error_)) {
        setNotice(error_ instanceof Error ? error_.message : 'Could not choose folder.')
      }
    }
  }

  const renderPreview = useCallback(
    (sourceTimestamp: number, signal: AbortSignal) =>
      engine.renderFrame(sourceTimestamp, 'jpeg', 92, { forPreview: true, signal }).then((r) => r.blob),
    [engine],
  )

  const formatInfo = FRAME_EXPORT_FORMATS[exportFormat]
  const downloadTargetsCount = selectedFrames.length > 0 ? selectedFrames.length : frames.length
  const extractPct =
    extractEstimate && extractEstimate > 0 ? Math.min(100, (frames.length / extractEstimate) * 100) : 0
  const exportPct =
    exportProgress.total > 0 ? Math.min(100, (exportProgress.done / exportProgress.total) * 100) : 0

  const rangeChanged =
    meta !== null && (startSec > 0.01 || Math.abs(endSec - meta.duration) > 0.05)

  const isFallback = meta?.engine === 'video-element'
  const fpsExceedsSource = Boolean(meta?.fps && mode === 'fps' && fps > meta.fps)
  const lightboxOpen = meta !== null && inspectIndex !== null

  const downloadLabel =
    downloadTargetsCount === 1
      ? `Download 1 frame (${formatInfo.label})`
      : selectedFrames.length > 0
        ? `Download ${selectedFrames.length} selected (${destination === 'zip' ? 'ZIP' : destination === 'folder' ? 'Folder' : formatInfo.label})`
        : `Download all ${frames.length} frames (${destination === 'zip' ? 'ZIP' : destination === 'folder' ? 'Folder' : formatInfo.label})`

  const settingsSummary = [
    mode === 'all'
      ? 'All frames'
      : mode === 'keyframes'
        ? isFallback
          ? '1 fps approx.'
          : 'Keyframes'
        : mode === 'fps'
          ? `${fps} fps`
          : `Every ${everyN} frames`,
    formatInfo.label,
    formatInfo.supportsQuality ? `q=${exportQuality}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <div className="app" {...(lightboxOpen ? { inert: true } : {})}>
        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_ACCEPT_ATTR}
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0]
            if (picked) { void loadVideoFile(picked) }
            e.target.value = ''
          }}
        />

        <AppHeader
          className="topbar"
          app="image"
          homeHref="/"
          actions={
            <>
              <a href="/" onClick={(e) => handleNavClick(e, '/')}>
                Convert
              </a>
              <a href="/generate" onClick={(e) => handleNavClick(e, '/generate')}>
                Generate
              </a>
              <a href="https://github.com/irshadnazree/just-image-things" target="_blank" rel="noreferrer">
                Source
              </a>
              <AppHeaderBadge title="Videos are decoded locally with WebCodecs in your browser">
                Runs locally · nothing uploaded
              </AppHeaderBadge>
              <ThemeToggle />
            </>
          }
        />

        <aside className={`sidebar ${settingsOpen ? 'is-open' : ''}`} aria-label="Video frame settings">
          <div className="settings">
            <div className="sheet-head">
              <h2>Frame settings</h2>
              <Button variant="primary" onClick={() => setSettingsOpen(false)}>
                Done
              </Button>
            </div>

            {meta && (
              <Section
                title="Video"
                aside={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="spacer-left"
                    disabled={opening || exporting}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Replace
                  </Button>
                }
              >
                <div className="video-meta-card">
                  <div className="video-meta-name" title={meta.fileName}>
                    {meta.fileName}
                  </div>
                  <div className="video-meta-specs num muted">
                    <span>
                      {meta.width}×{meta.height}
                    </span>
                    <span>{formatTimecode(meta.duration)}</span>
                    {meta.fps && <span>{meta.fps} fps</span>}
                    <span>{formatBytes(meta.fileSize)}</span>
                  </div>
                  <div className="video-meta-tags">
                    {meta.formatName && <span className="tag">{meta.formatName}</span>}
                    {meta.codec && <span className="tag">{meta.codec}</span>}
                    <span className="tag">
                      {meta.engine === 'webcodecs' ? 'WEBCODECS' : 'VIDEO FALLBACK'}
                    </span>
                  </div>
                </div>
              </Section>
            )}

            <Section title="Frame extraction">
              <Segmented
                label="Extraction mode"
                value={mode}
                options={SAMPLING_MODES}
                onChange={handleModeChange}
              />

              {mode === 'fps' && (
                <>
                  <div className="chip-row">
                    {FPS_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={fps === preset}
                        className={`chip chip-sm ${fps === preset ? 'is-active' : ''}`}
                        onClick={() => handleFpsPresetClick(preset)}
                      >
                        {preset} fps
                      </button>
                    ))}
                  </div>
                  <Field label="Custom frame rate">
                    <NumberInput
                      label="Frames per second"
                      value={fps}
                      min={1}
                      max={120}
                      suffix="fps"
                      onChange={handleFpsInputChange}
                    />
                  </Field>
                  {fpsExceedsSource && meta?.fps && (
                    <p className="note">
                      Source is {meta.fps} fps — duplicate timestamps are skipped automatically.
                    </p>
                  )}
                </>
              )}

              {mode === 'every-n' && (
                <Field
                  label="Keep every Nth frame"
                  hint={
                    isFallback
                      ? 'Browser fallback approximates frame cadence at 30 fps.'
                      : 'Skips intermediate frames while scanning sequentially.'
                  }
                >
                  <NumberInput
                    label="Frame interval"
                    value={everyN}
                    min={1}
                    max={1000}
                    suffix="frames"
                    onChange={handleEveryNChange}
                  />
                </Field>
              )}

              {mode === 'keyframes' && (
                <p className="note">
                  {isFallback
                    ? 'Browser video fallback cannot read container keyframe indices — samples approximately 1 frame per second instead.'
                    : 'Extracts only I-frames (keyframes) directly from the container index — instant even on large files.'}
                </p>
              )}

              {mode === 'all' && (
                <p className="note">
                  {isFallback
                    ? 'Browser video fallback samples approximately 30 fps (exact frame decoding requires WebCodecs).'
                    : `Decodes every frame sequentially in a Web Worker (up to ${DEFAULT_MAX_FRAMES.toLocaleString()} frames per scan).`}
                </p>
              )}

              {meta && meta.duration > 0 && (
                <div className="field">
                  <div className="slider-top">
                    <span className="field-label">Time range (seconds)</span>
                    {rangeChanged && (
                      <button
                        type="button"
                        className="link-reset"
                        onClick={() => {
                          const fullEnd = Math.round(meta.duration * 100) / 100
                          setStartSec(0)
                          setEndSec(fullEnd)
                          triggerReExtract({ startSec: 0, endSec: meta.duration })
                        }}
                      >
                        Full clip
                      </button>
                    )}
                  </div>
                  <div className="inline-fields">
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label="Start time in seconds"
                      min={0}
                      max={meta.duration}
                      step={0.1}
                      value={startSec}
                      onChange={(e) => setStartSec(Math.max(0, Number(e.target.value) || 0))}
                    />
                    <span className="times" aria-hidden>
                      –
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      aria-label="End time in seconds"
                      min={0}
                      max={meta.duration}
                      step={0.1}
                      value={endSec}
                      onChange={(e) => setEndSec(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={opening || exporting}
                    onClick={() => triggerReExtract()}
                  >
                    Apply range
                  </Button>
                </div>
              )}
            </Section>

            <Section title="Download format">
              <div className="format-grid video-format-grid" role="radiogroup" aria-label="Download image format">
                {FRAME_FORMAT_ORDER.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={exportFormat === id}
                    className={`chip ${exportFormat === id ? 'is-active' : ''}`}
                    onClick={() => {
                      setExportFormat(id)
                      setConfirmWarningKey(null)
                    }}
                  >
                    {FRAME_EXPORT_FORMATS[id].label}
                  </button>
                ))}
              </div>
              {formatInfo.supportsQuality ? (
                <Slider
                  label="Quality"
                  value={exportQuality}
                  min={10}
                  max={100}
                  onChange={setExportQuality}
                  format={(v) => `${v}%`}
                />
              ) : (
                <p className="note">Lossless full-resolution PNG. Clipboard copy always uses PNG.</p>
              )}

              <Field label="Multi-frame download">
                <Segmented
                  label="Multi-frame download destination"
                  value={destination}
                  options={[
                    { value: 'zip', label: 'ZIP' },
                    ...(supportsFolderOutput ? [{ value: 'folder' as const, label: 'Folder' }] : []),
                    { value: 'files', label: 'Files' },
                  ]}
                  onChange={(v) => {
                    setDestination(v)
                    setConfirmWarningKey(null)
                  }}
                />
              </Field>
              {destination === 'folder' && supportsFolderOutput && (
                <div className="folder-row">
                  <span className="muted">
                    {folderHandle ? `Folder: ${folderHandle.name}` : 'Pick a destination folder on download'}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void handlePickFolder()}>
                    {folderHandle ? 'Change' : 'Choose'}
                  </Button>
                </div>
              )}
            </Section>
          </div>
        </aside>

        <main className="main">
          {!meta ? (
            <div className="empty">
              <div className="empty-inner">
                <div className="empty-mark" aria-hidden>
                  <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="10" width="36" height="28" rx="3" />
                    <path d="M14 10v28M34 10v28M6 17h8M6 24h8M6 31h8M34 17h8M34 24h8M34 31h8" />
                    <path d="M21 19.5 29 24l-8 4.5z" fill="currentColor" stroke="none" />
                  </svg>
                </div>
                <h1>
                  <span className="for-pointer">Drop a video to inspect every frame</span>
                  <span className="for-touch">Choose a video to inspect every frame</span>
                </h1>
                <p className="empty-lede">
                  Hardware-accelerated WebCodecs decoding in a Web Worker. Copy any frame to clipboard or batch download
                  selected frames at full resolution — nothing is uploaded.
                </p>
                <div className="empty-actions">
                  <Button
                    variant="primary"
                    disabled={opening}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {opening ? 'Opening video…' : 'Choose video'}
                  </Button>
                </div>
                {error && (
                  <p className="note error-text" role="alert">
                    {error}
                  </p>
                )}
                <p className="formats">
                  {['MP4', 'MOV', 'WebM', 'MKV', 'OGG', 'H.264', 'HEVC', 'VP9', 'AV1'].join('\u00a0· ')}
                </p>
                <Button variant="ghost" className="empty-settings" onClick={() => setSettingsOpen(true)}>
                  Choose extraction settings first
                </Button>
              </div>
            </div>
          ) : (
            <div className="video-workspace">
              <div className="preview-bar video-toolbar">
                <span className="preview-title num">
                  {frames.length.toLocaleString()} {frames.length === 1 ? 'frame' : 'frames'}
                  {selected.size > 0 && (
                    <span className="video-selected-pill"> · {selected.size.toLocaleString()} selected</span>
                  )}
                  {!extracting && extractMs !== null && (
                    <span className="muted"> · parsed in {formatDuration(extractMs)}</span>
                  )}
                </span>
                {extracting && <span className="spinner" aria-label="Extracting frames" />}
                <span className="spacer" />
                <div className="video-toolbar-controls">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={frames.length === 0 || selected.size === frames.length}
                    onClick={handleSelectAll}
                  >
                    Select all
                  </Button>
                  {selected.size > 0 && (
                    <>
                      <Button size="sm" variant="ghost" onClick={handleInvertSelection}>
                        Invert
                      </Button>
                      <Button size="sm" variant="ghost" onClick={handleClearSelection}>
                        Clear
                      </Button>
                    </>
                  )}
                  <div className="segmented segmented-sm" role="radiogroup" aria-label="Thumbnail size">
                    {DENSITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={density === opt.value}
                        className={density === opt.value ? 'is-active' : ''}
                        onClick={() => setDensity(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {error && (
                <div className="stale-band generate-banner is-warn" role="alert">
                  <span>{error}</span>
                </div>
              )}

              {truncated && !extracting && (
                <div className="stale-band generate-banner" role="status">
                  <span>
                    Stopped at {DEFAULT_MAX_FRAMES.toLocaleString()} frames to keep memory fast. Narrow the time range or
                    switch to FPS / Keyframes to cover the whole clip.
                  </span>
                </div>
              )}

              {extractCancelled && !extracting && (
                <div className="stale-band generate-banner" role="status">
                  <span>
                    Extraction stopped early. Showing the {frames.length.toLocaleString()} frames decoded so far.
                  </span>
                </div>
              )}

              {frames.length > 0 ? (
                <FrameGrid
                  frames={frames}
                  aspectRatio={meta.width / Math.max(1, meta.height)}
                  density={density}
                  selected={selected}
                  copiedIndex={copiedIndex}
                  busyCopyIndex={busyCopyIndex}
                  onToggleSelect={handleToggleSelect}
                  onInspect={setInspectIndex}
                  onCopy={(frame) => void handleCopyFrame(frame)}
                  onDownload={(frame) => void handleDownloadSingle(frame)}
                />
              ) : (
                <div className="video-grid-empty muted">
                  {extracting ? 'Decoding frames with WebCodecs…' : 'No frames found in this range.'}
                </div>
              )}

              <div className="preview-stats num">
                <span className="muted for-pointer">
                  Click to select · Shift+click for range · Double-click to inspect full resolution
                </span>
                <span className="muted for-touch">Tap to select · Use icons to inspect, copy, or download</span>
                <span className="spacer" />
                <span>
                  Full export: <strong>{meta.width}×{meta.height}</strong> {formatInfo.label}
                </span>
              </div>
            </div>
          )}
        </main>

        <div className={`run-bar ${!meta ? 'is-empty' : ''}`}>
          {extracting ? (
            <>
              <div
                className={`progress ${extractEstimate ? '' : 'is-indeterminate'}`}
                role="progressbar"
                aria-label="Extracting video frames"
                aria-valuemin={0}
                aria-valuemax={extractEstimate ?? 1}
                aria-valuenow={frames.length}
              >
                <div className="progress-fill" style={{ width: `${extractPct}%` }} />
              </div>
              <div className="run-stats num" role="status" aria-live="polite">
                <span>
                  <strong>{frames.length.toLocaleString()}</strong>
                  {extractEstimate ? ` / ~${extractEstimate.toLocaleString()}` : ''} frames decoded
                </span>
                <span className="muted">
                  {meta?.engine === 'webcodecs' ? 'Hardware-accelerated WebCodecs worker' : 'Browser video decoder'}
                </span>
              </div>
              <Button className="run-button" onClick={handleStopExtract}>
                Stop extraction
              </Button>
            </>
          ) : exporting ? (
            <>
              <div
                className="progress"
                role="progressbar"
                aria-label="Exporting selected frames"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, exportProgress.total)}
                aria-valuenow={exportProgress.done}
              >
                <div className="progress-fill" style={{ width: `${exportPct}%` }} />
              </div>
              <div className="run-stats num" role="status" aria-live="polite">
                <span>
                  Exporting <strong>{exportProgress.done}</strong> of {exportProgress.total} frames
                </span>
                <span className="muted">Rendering full resolution ({meta ? `${meta.width}×${meta.height}` : ''})</span>
              </div>
              <Button className="run-button" onClick={() => engine.cancelExport()}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <div className="run-settings">
                <span className="run-settings-text">{settingsSummary}</span>
                <Button size="sm" onClick={() => setSettingsOpen(true)}>
                  Settings
                </Button>
              </div>
              {notice && (
                <p className="notice" role="status" aria-live="polite">
                  {notice}
                </p>
              )}
              {selectedFrames.length === 1 && (
                <Button
                  className="run-button"
                  variant="secondary"
                  disabled={busyCopyIndex !== null}
                  onClick={() => void handleCopyFrame(selectedFrames[0])}
                >
                  {copiedIndex === selectedFrames[0].index ? 'Copied to clipboard' : 'Copy selected frame'}
                </Button>
              )}
              <Button
                className="run-button"
                variant="primary"
                disabled={!meta || frames.length === 0 || opening}
                onClick={() => void handleDownloadBatch()}
              >
                {meta && frames.length > 0 ? downloadLabel : 'Choose a video first'}
              </Button>
            </>
          )}
        </div>

        {dragActive && (
          <div className="drop-overlay" aria-hidden>
            <div className="drop-overlay-inner">
              {exporting ? 'Wait for export to finish' : 'Drop video to extract frames'}
            </div>
          </div>
        )}
      </div>

      {lightboxOpen && (
        <FrameLightbox
          frames={frames}
          activeIndex={inspectIndex}
          meta={meta}
          selected={selected}
          copiedIndex={copiedIndex}
          busyCopyIndex={busyCopyIndex}
          renderPreview={renderPreview}
          onClose={() => setInspectIndex(null)}
          onChangeIndex={setInspectIndex}
          onToggleSelect={(index) => handleToggleSelect(index, false)}
          onCopy={(frame) => void handleCopyFrame(frame)}
          onDownload={(frame) => void handleDownloadSingle(frame)}
        />
      )}
    </>
  )
}

import { Button } from '@irshadnazree/just-things-ui'
import { useEffect, useRef, useState } from 'react'
import { formatFrameLabel, formatTimecode } from '../lib/video-frames'
import type { FrameRecord, VideoMetadata } from '../lib/video-frames'

const PREVIEW_DEBOUNCE_MS = 80

interface FrameLightboxProps {
  frames: Array<FrameRecord>
  activeIndex: number
  meta: VideoMetadata
  selected: ReadonlySet<number>
  copiedIndex: number | null
  busyCopyIndex: number | null
  renderPreview: (sourceTimestamp: number, signal: AbortSignal) => Promise<Blob>
  onClose: () => void
  onChangeIndex: (index: number) => void
  onToggleSelect: (index: number) => void
  onCopy: (frame: FrameRecord) => void
  onDownload: (frame: FrameRecord) => void
}

function focusableElements(root: HTMLElement): Array<HTMLElement> {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

export function FrameLightbox({
  frames,
  activeIndex,
  meta,
  selected,
  copiedIndex,
  busyCopyIndex,
  renderPreview,
  onClose,
  onChangeIndex,
  onToggleSelect,
  onCopy,
  onDownload,
}: FrameLightboxProps) {
  const frame = frames[activeIndex]
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [loadedFull, setLoadedFull] = useState<{ index: number; url: string } | null>(null)
  const [failedIndex, setFailedIndex] = useState<number | null>(null)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    document.documentElement.classList.add('sheet-open')
    closeButtonRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sheet-open')
      previousFocus?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (!frame) { return }
    const controller = new AbortController()
    let objectUrl: string | null = null
    const timer = setTimeout(() => {
      void renderPreview(frame.sourceTimestamp, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) { return }
          objectUrl = URL.createObjectURL(blob)
          setLoadedFull({ index: frame.index, url: objectUrl })
        })
        .catch((error_: unknown) => {
          if (controller.signal.aborted) { return }
          if (error_ instanceof DOMException && error_.name === 'AbortError') { return }
          setFailedIndex(frame.index)
        })
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
      if (objectUrl) { URL.revokeObjectURL(objectUrl) }
    }
  }, [frame, renderPreview])

  useEffect(() => {
    if (!frame) { return }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = focusableElements(dialogRef.current)
        if (focusables.length === 0) { return }
        const first = focusables[0]
        const last = focusables.at(-1)
        if (!last) { return }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (activeIndex > 0) { onChangeIndex(activeIndex - 1) }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (activeIndex < frames.length - 1) { onChangeIndex(activeIndex + 1) }
      } else if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onToggleSelect(frame.index)
      } else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onCopy(frame)
      } else if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onDownload(frame)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIndex, frame, frames.length, onChangeIndex, onClose, onCopy, onDownload, onToggleSelect])

  if (!frame) { return null }

  const fullUrl = loadedFull && loadedFull.index === frame.index ? loadedFull.url : null
  const failed = failedIndex === frame.index
  const loadingFull = fullUrl === null && !failed
  const isSelected = selected.has(frame.index)
  const isCopied = copiedIndex === frame.index
  const isCopying = busyCopyIndex === frame.index
  const fullLabel = formatFrameLabel(frame.frameNumber, frame.numbering, true)

  return (
    <div
      ref={dialogRef}
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${fullLabel} preview`}
    >
      <div className="lightbox-bar">
        <div className="lightbox-info num">
          <strong>{fullLabel}</strong>
          <span className="mono muted">{formatTimecode(frame.timestamp)}</span>
          <span className="muted">
            {meta.width}×{meta.height}
          </span>
          {frame.isKeyframe && <span className="tag">KEYFRAME</span>}
          {loadingFull && <span className="spinner" aria-label="Loading full resolution frame" />}
          {failed && <span className="note error-text">Full resolution unavailable — showing thumbnail</span>}
        </div>
        <div className="lightbox-actions">
          <Button
            size="sm"
            variant={isSelected ? 'primary' : 'secondary'}
            onClick={() => onToggleSelect(frame.index)}
          >
            {isSelected ? 'Selected' : 'Select'}
          </Button>
          <Button size="sm" variant="secondary" disabled={isCopying} onClick={() => onCopy(frame)}>
            {isCopied ? 'Copied' : isCopying ? 'Copying…' : 'Copy'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => onDownload(frame)}>
            Download
          </Button>
          <Button
            ref={closeButtonRef}
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close preview"
          >
            Close
          </Button>
        </div>
      </div>

      <div className="lightbox-stage">
        <button
          type="button"
          className="lightbox-nav lightbox-prev"
          disabled={activeIndex <= 0}
          aria-label="Previous frame"
          onClick={() => onChangeIndex(activeIndex - 1)}
        >
          ‹
        </button>

        <div className="lightbox-media checker">
          <img
            src={fullUrl ?? frame.thumbUrl}
            alt={`${fullLabel} at ${formatTimecode(frame.timestamp)}`}
            className="lightbox-img"
          />
        </div>

        <button
          type="button"
          className="lightbox-nav lightbox-next"
          disabled={activeIndex >= frames.length - 1}
          aria-label="Next frame"
          onClick={() => onChangeIndex(activeIndex + 1)}
        >
          ›
        </button>
      </div>

      <div className="lightbox-foot muted small num">
        <span>
          {activeIndex + 1} / {frames.length}
        </span>
        <span className="for-pointer">
          ←/→ step · S select · C copy · D download · Esc close
        </span>
      </div>
    </div>
  )
}

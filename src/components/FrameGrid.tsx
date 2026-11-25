import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatFrameLabel, formatTimecode } from '../lib/video-frames'
import type { FrameRecord, GridDensity } from '../lib/video-frames'

const MIN_TILE_WIDTH: Record<GridDensity, number> = {
  sm: 152,
  md: 216,
  lg: 300,
}

const GRID_GAP = 10
const GRID_PADDING = 16
const CARD_FOOTER_HEIGHT = 32
const CARD_BORDER_Y = 2
const OVERSCAN_ROWS = 3

interface FrameGridProps {
  frames: Array<FrameRecord>
  aspectRatio: number
  density: GridDensity
  selected: ReadonlySet<number>
  copiedIndex: number | null
  busyCopyIndex: number | null
  onToggleSelect: (index: number, shiftKey: boolean) => void
  onInspect: (index: number) => void
  onCopy: (frame: FrameRecord) => void
  onDownload: (frame: FrameRecord) => void
}

export function FrameGrid({
  frames,
  aspectRatio,
  density,
  selected,
  copiedIndex,
  busyCopyIndex,
  onToggleSelect,
  onInspect,
  onCopy,
  onDownload,
}: FrameGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) { return }
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(
    () => () => {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current) }
    },
    [],
  )

  const safeAspect = Math.min(3, Math.max(0.4, Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9))
  const innerWidth = Math.max(200, (size.width || 800) - GRID_PADDING * 2)
  const minTile = MIN_TILE_WIDTH[density]
  const cols = Math.max(1, Math.floor((innerWidth + GRID_GAP) / (minTile + GRID_GAP)))
  const tileWidth = (innerWidth - GRID_GAP * (cols - 1)) / cols
  const thumbHeight = Math.max(72, Math.round(tileWidth / safeAspect))
  const cardHeight = thumbHeight + CARD_FOOTER_HEIGHT + CARD_BORDER_Y
  const rowPitch = cardHeight + GRID_GAP
  const totalRows = Math.ceil(frames.length / cols)
  const totalHeight = totalRows > 0 ? totalRows * rowPitch - GRID_GAP + GRID_PADDING * 2 : 0

  const layoutRef = useRef({ cols, rowPitch })
  useLayoutEffect(() => {
    const prev = layoutRef.current
    layoutRef.current = { cols, rowPitch }
    const el = scrollRef.current
    if (!el || (prev.cols === cols && prev.rowPitch === rowPitch)) { return }
    if (el.scrollTop <= GRID_PADDING) { return }
    const prevFirstRow = Math.max(0, Math.floor((el.scrollTop - GRID_PADDING) / prev.rowPitch))
    const firstIndex = prevFirstRow * prev.cols
    const nextRow = Math.floor(firstIndex / cols)
    const nextScrollTop = GRID_PADDING + nextRow * rowPitch
    el.scrollTop = nextScrollTop
  }, [cols, rowPitch])

  const handleScroll = () => {
    if (rafRef.current !== null) { return }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (scrollRef.current) {
        setScrollTop(scrollRef.current.scrollTop)
      }
    })
  }

  const viewportHeight = size.height || 700
  const startRow = Math.max(0, Math.floor((scrollTop - GRID_PADDING) / rowPitch) - OVERSCAN_ROWS)
  const endRow = Math.min(
    Math.max(0, totalRows - 1),
    Math.ceil((scrollTop + viewportHeight - GRID_PADDING) / rowPitch) + OVERSCAN_ROWS,
  )

  const startIndex = startRow * cols
  const endIndex = Math.min(frames.length, (endRow + 1) * cols)
  const visibleFrames = frames.slice(startIndex, endIndex)
  const offsetY = GRID_PADDING + startRow * rowPitch

  return (
    <div ref={scrollRef} className="frame-grid-scroll" onScroll={handleScroll}>
      <div className="frame-grid-spacer" style={{ height: totalHeight }}>
        {visibleFrames.length > 0 && (
          <div
            className="frame-grid-window"
            style={{
              transform: `translateY(${offsetY}px)`,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: `${GRID_GAP}px`,
              padding: `0 ${GRID_PADDING}px`,
            }}
          >
            {visibleFrames.map((frame) => {
              const isSelected = selected.has(frame.index)
              const isCopied = copiedIndex === frame.index
              const isCopying = busyCopyIndex === frame.index
              const label = formatFrameLabel(frame.frameNumber, frame.numbering)
              const fullLabel = formatFrameLabel(frame.frameNumber, frame.numbering, true)
              return (
                <article
                  key={frame.index}
                  className={`frame-card ${isSelected ? 'is-selected' : ''}`}
                  style={{ height: cardHeight }}
                >
                  <button
                    type="button"
                    className="frame-card-hit"
                    aria-pressed={isSelected}
                    aria-label={`Select ${fullLabel} at ${formatTimecode(frame.timestamp)}`}
                    onClick={(e) => onToggleSelect(frame.index, e.shiftKey)}
                    onDoubleClick={() => onInspect(frame.index)}
                  >
                    <div className="frame-thumb-wrap" style={{ height: thumbHeight }}>
                      <img
                        src={frame.thumbUrl}
                        alt={`${fullLabel} at ${formatTimecode(frame.timestamp)}`}
                        className="frame-thumb"
                        decoding="async"
                        draggable={false}
                      />
                      <span className={`frame-check ${isSelected ? 'is-checked' : ''}`} aria-hidden>
                        {isSelected && (
                          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2">
                            <path d="M2 6.2 4.7 9 10 3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      {frame.isKeyframe && <span className="frame-kf-tag">KEY</span>}
                    </div>
                  </button>

                  <div className="frame-card-actions">
                    <button
                      type="button"
                      className="frame-action-btn"
                      title="Inspect full resolution"
                      aria-label={`Inspect ${fullLabel}`}
                      onClick={() => onInspect(frame.index)}
                    >
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`frame-action-btn ${isCopied ? 'is-copied' : ''}`}
                      title="Copy full-resolution frame to clipboard"
                      aria-label={`Copy ${fullLabel} to clipboard`}
                      disabled={isCopying}
                      onClick={() => onCopy(frame)}
                    >
                      {isCopied ? (
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
                          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="frame-action-btn"
                      title="Download full-resolution frame"
                      aria-label={`Download ${fullLabel}`}
                      onClick={() => onDownload(frame)}
                    >
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M8 2.5v8m0 0-3-3m3 3 3-3M2.5 13h11" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>

                  <div className="frame-card-meta num">
                    <span className="frame-num" title={fullLabel}>
                      {label}
                    </span>
                    <span className="frame-ts mono muted">{formatTimecode(frame.timestamp)}</span>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

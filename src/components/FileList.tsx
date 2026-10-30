import { useEffect, useRef, useState } from 'react'
import { useFreshStats, useStore, type Item } from '../app/store'
import { FORMAT_BY_ID, formatFromName, INPUT_LABELS } from '../lib/formats'
import { formatBytes, formatDelta, formatDuration } from '../lib/format-bytes'
import { AddButtons } from './Intake'

const ROW_HEIGHT = 40
const OVERSCAN = 8

const STATUS_LABEL: Record<Item['status'], string> = {
  idle: 'Ready',
  queued: 'Queued',
  processing: 'Working',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Failed',
}

/** Shape as well as colour, so status reads without telling green from red. */
function StatusIcon({ status }: { status: Item['status'] }) {
  if (status === 'processing') return <span className="spinner" />
  if (status === 'done')
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5l3.2 3L13 4.5" />
      </svg>
    )
  if (status === 'error')
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    )
  if (status === 'skipped')
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 8h8" />
      </svg>
    )
  return <span className="status-ring" />
}

function Row({ item, selected, onSelect, onRemove, running, showFormat, stale }: {
  item: Item
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  running: boolean
  showFormat: boolean
  stale: boolean
}) {
  const slash = item.relPath.lastIndexOf('/')
  const dir = slash >= 0 ? item.relPath.slice(0, slash + 1) : ''
  const name = item.relPath.slice(slash + 1)
  const inFmt = formatFromName(item.file.name)
  const done = item.status === 'done' && item.outSize !== undefined
  const smaller = done && item.outSize! < item.file.size
  const outdated = stale && item.status !== 'idle'

  return (
    <div
      role="row"
      aria-selected={selected}
      className={`row status-${item.status} ${selected ? 'is-selected' : ''} ${outdated ? 'is-outdated' : ''}`}
      onClick={onSelect}
      title={item.error ?? item.outPath ?? item.relPath}
    >
      <span className="status" role="img" aria-label={`${STATUS_LABEL[item.status]}${outdated ? ', from the last run' : ''}`}>
        <StatusIcon status={item.status} />
      </span>
      <span className="row-name">
        {dir && <span className="muted">{dir}</span>}
        {name}
      </span>
      <span className="row-fmt">{inFmt ? INPUT_LABELS[inFmt] : ''}</span>
      <span className="row-size num">{formatBytes(item.file.size)}</span>
      <span className="row-out num">
        {item.status === 'error' ? (
          <span className="error-text">{item.error}</span>
        ) : item.status === 'skipped' ? (
          <span className="muted">Skipped, already exists</span>
        ) : done ? (
          <>
            {showFormat && <span className="tag">{FORMAT_BY_ID[item.outFormat!].label}</span>}
            {formatBytes(item.outSize!)}
            <span className={`delta ${smaller ? 'good' : 'bad'}`}>
              {item.kept ? 'kept' : formatDelta(item.file.size, item.outSize!)}
            </span>
          </>
        ) : item.status === 'processing' ? (
          <span className="muted">Converting…</span>
        ) : item.status === 'queued' ? (
          <span className="muted">Queued</span>
        ) : (
          <span className="muted">Ready</span>
        )}
      </span>
      <button
        type="button"
        className="row-remove"
        aria-label={`Remove ${name}`}
        disabled={running}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
    </div>
  )
}

function ResultBand() {
  const stats = useFreshStats()
  const last = useStore((s) => s.stats)
  const running = useStore((s) => s.running)
  const notice = useStore((s) => s.notice)
  const destination = useStore((s) => s.settings.output.destination)
  if (!stats) {
    if (running || !last?.finishedAt || last.cancelled) return null
    return (
      <div className="stale-band" role="status">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v4M8 4.8v.01" />
        </svg>
        <span>
          <strong>Settings changed.</strong> The sizes below are from the last run
          {last.settings.format === 'original' ? '' : ` (${FORMAT_BY_ID[last.settings.format].label})`}. Convert again to
          apply the new settings.
        </span>
      </div>
    )
  }

  const smaller = stats.bytesOut < stats.bytesIn
  const where = notice ?? (destination === 'files' || stats.total === 1 ? 'Sent to your downloads' : null)

  return (
    <div className="result-band num" role="status">
      {stats.bytesIn > 0 && (
        <span className={`result-big ${smaller ? 'good' : 'bad'}`}>{formatDelta(stats.bytesIn, stats.bytesOut)}</span>
      )}
      <span className="result-text">
        <span>
          <strong>
            {stats.done.toLocaleString()} {stats.done === 1 ? 'image' : 'images'}
          </strong>{' '}
          {formatBytes(stats.bytesIn)} → {formatBytes(stats.bytesOut)}
          {stats.failed > 0 && <span className="error-text"> · {stats.failed} failed</span>}
        </span>
        <span className="muted">
          {formatDuration(stats.finishedAt! - stats.startedAt)}
          {where && ` · ${where}`}
        </span>
      </span>
    </div>
  )
}

export function FileList() {
  const items = useStore((s) => s.items)
  const selectedId = useStore((s) => s.selectedId)
  const running = useStore((s) => s.running)
  const select = useStore((s) => s.select)
  const removeItem = useStore((s) => s.removeItem)
  const clear = useStore((s) => s.clear)
  const showFormat = useStore((s) => (s.stats?.settings ?? s.settings).format === 'original')
  const fresh = useFreshStats()
  const lastRun = useStore((s) => s.stats)
  const stale = !running && !fresh && !!lastRun?.finishedAt && !lastRun.cancelled
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const totalSize = items.reduce((n, i) => n + i.file.size, 0)
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)

  const move = (delta: number) => {
    const idx = items.findIndex((i) => i.id === selectedId)
    const next = items[Math.min(items.length - 1, Math.max(0, idx + delta))]
    if (!next) return
    select(next.id)
    const el = scroller.current
    const pos = items.indexOf(next) * ROW_HEIGHT
    if (el && (pos < el.scrollTop || pos + ROW_HEIGHT > el.scrollTop + el.clientHeight)) {
      el.scrollTop = pos - el.clientHeight / 2
    }
  }

  return (
    <div className="file-list">
      <ResultBand />
      <div className="list-toolbar">
        <span className="num list-count">
          <strong>{items.length.toLocaleString()}</strong> {items.length === 1 ? 'image' : 'images'}
          <span className="muted"> · {formatBytes(totalSize)}</span>
        </span>
        <span className="spacer" />
        <AddButtons compact disabled={running} />
        <button type="button" className="btn btn-ghost" onClick={clear} disabled={running}>
          Clear
        </button>
      </div>
      <div
        ref={scroller}
        className="list-scroll"
        role="grid"
        aria-label="Images"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            move(1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            move(-1)
          }
        }}
      >
        <div style={{ height: items.length * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {items.slice(first, last).map((item) => (
              <Row
                key={item.id}
                item={item}
                running={running}
                selected={item.id === selectedId}
                onSelect={() => select(item.id)}
                onRemove={() => removeItem(item.id)}
                showFormat={showFormat}
                stale={stale}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

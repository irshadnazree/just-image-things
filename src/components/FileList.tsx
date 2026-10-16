import { useEffect, useRef, useState } from 'react'
import { useStore, type Item } from '../app/store'
import { FORMAT_BY_ID, formatFromName, INPUT_LABELS } from '../lib/formats'
import { formatBytes, formatDelta } from '../lib/format-bytes'
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

function Row({ item, selected, onSelect, onRemove, running }: {
  item: Item
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  running: boolean
}) {
  const slash = item.relPath.lastIndexOf('/')
  const dir = slash >= 0 ? item.relPath.slice(0, slash + 1) : ''
  const name = item.relPath.slice(slash + 1)
  const inFmt = formatFromName(item.file.name)
  const done = item.status === 'done' && item.outSize !== undefined
  const smaller = done && item.outSize! < item.file.size

  return (
    <div
      role="row"
      aria-selected={selected}
      className={`row status-${item.status} ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      title={item.error ?? item.outPath ?? item.relPath}
    >
      <span className="status-dot" aria-label={STATUS_LABEL[item.status]} />
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
          <span className="muted">exists</span>
        ) : done ? (
          <>
            <span className="tag">{FORMAT_BY_ID[item.outFormat!].label}</span>
            {formatBytes(item.outSize!)}
            <span className={smaller ? 'good' : 'bad'}>{item.kept ? 'kept' : formatDelta(item.file.size, item.outSize!)}</span>
          </>
        ) : item.status === 'processing' ? (
          <span className="spinner" aria-label="Processing" />
        ) : null}
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

export function FileList() {
  const items = useStore((s) => s.items)
  const selectedId = useStore((s) => s.selectedId)
  const running = useStore((s) => s.running)
  const select = useStore((s) => s.select)
  const removeItem = useStore((s) => s.removeItem)
  const clear = useStore((s) => s.clear)
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
      <div className="list-toolbar">
        <span className="num">
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
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

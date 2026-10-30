import { useEffect, useMemo, useRef, useState } from 'react'
import { PreviewRunner } from '../app/preview'
import { useStore } from '../app/store'
import { rasterizeSvg } from '../app/svg'
import { FORMAT_BY_ID, INPUT_LABELS } from '../lib/formats'
import { formatBytes, formatDelta, formatDuration } from '../lib/format-bytes'
import type { PreviewResult } from '../worker/protocol'

type Meta = Omit<PreviewResult, 'before' | 'after' | 'type'>

function draw(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap) {
  const ctx = canvas?.getContext('bitmaprenderer')
  if (ctx) ctx.transferFromImageBitmap(bitmap)
  else bitmap.close()
}

export function Preview() {
  const item = useStore((s) => s.items.find((i) => i.id === s.selectedId) ?? null)
  const settings = useStore((s) => s.settings)
  const runner = useMemo(() => new PreviewRunner(), [])
  const beforeRef = useRef<HTMLCanvasElement>(null)
  const afterRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [meta, setMeta] = useState<Meta | null>(null)
  const [shownId, setShownId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState(50)
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => () => runner.dispose(), [runner])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  // Only settings that change the pixels or bytes re-render the preview; where files go and how they're named don't.
  const { output: _output, workers: _workers, rename: _rename, ...visual } = settings
  const visualKey = JSON.stringify(visual)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the visual settings on purpose
  const previewSettings = useMemo(() => settings, [visualKey])

  const file = item?.file
  const itemId = item?.id
  useEffect(() => {
    if (!file || itemId === undefined || collapsed) return
    let stale = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const raster = /\.svg$/i.test(file.name) ? await rasterizeSvg(file, previewSettings) : undefined
        const result = await runner.request({ type: 'preview', id: itemId, file, name: file.name, settings: previewSettings, raster })
        if (!result || stale) {
          result?.before.close()
          result?.after.close()
          return
        }
        const { before, after, type: _type, ...rest } = result
        draw(beforeRef.current, before)
        draw(afterRef.current, after)
        setMeta(rest)
        setShownId(itemId)
        setError(null)
        setLoading(false)
      } catch (err) {
        if (stale) return
        setError(err instanceof Error ? err.message : String(err))
        setShownId(null)
        setLoading(false)
      }
    }, 250)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [file, itemId, previewSettings, runner, collapsed])

  const setFromPointer = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }

  const ready = shownId === itemId && meta && !error

  // Canvases with a bitmaprenderer context ignore object-fit, so size the stage to the image ourselves.
  let stageSize: React.CSSProperties | undefined
  if (meta && ready) {
    if (zoom === 'actual') stageSize = { width: meta.width, height: meta.height }
    else {
      const scale = Math.min(viewport.width / meta.width, viewport.height / meta.height, 1)
      stageSize = { width: Math.floor(meta.width * scale), height: Math.floor(meta.height * scale) }
    }
  }
  const outLabel = meta ? FORMAT_BY_ID[meta.format].label : ''
  // While a new preview renders, the old one stays up but says it is out of date.
  const updating = ready && loading
  const target = settings.format === 'original' ? null : FORMAT_BY_ID[settings.format].label
  const updatingLabel = target && target !== outLabel ? `Updating to ${target}…` : 'Updating…'

  return (
    <div className={`preview ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="preview-bar">
        <span className="preview-title">
          Preview
          {item && <span className="muted"> · {item.file.name}</span>}
        </span>
        {loading && <span className="spinner" aria-label="Rendering preview" />}
        <span className="spacer" />
        {!collapsed && (
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Zoom">
            <button type="button" role="radio" aria-checked={zoom === 'fit'} className={zoom === 'fit' ? 'is-active' : ''} onClick={() => setZoom('fit')}>
              Fit
            </button>
            <button type="button" role="radio" aria-checked={zoom === 'actual'} className={zoom === 'actual' ? 'is-active' : ''} onClick={() => setZoom('actual')}>
              1:1
            </button>
          </div>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div ref={viewportRef} className={`preview-viewport zoom-${zoom} ${updating ? 'is-updating' : ''}`}>
            <div
              ref={stageRef}
              className={`preview-stage ${ready ? 'checker' : ''}`}
              style={stageSize}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                setFromPointer(e.clientX)
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromPointer(e.clientX)
              }}
            >
              <canvas ref={afterRef} className="preview-canvas preview-canvas-after" hidden={!ready} />
              <canvas
                ref={beforeRef}
                className="preview-canvas"
                hidden={!ready}
                style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              />
              {ready && (
                <div
                  className="compare-handle"
                  style={{ left: `${pos}%` }}
                  role="slider"
                  tabIndex={0}
                  aria-label="Compare original and output"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pos)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 5))
                    if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 5))
                  }}
                >
                  <span className="compare-knob" aria-hidden>⟷</span>
                </div>
              )}
              {ready && (
                <>
                  <span className="corner corner-left">Original</span>
                  <span className="corner corner-right">{updating ? updatingLabel : outLabel}</span>
                </>
              )}
              {error && <div className="preview-message error-text">Can't preview: {error}</div>}
              {!item && <div className="preview-message muted">Select an image to preview</div>}
            </div>
          </div>
          <div className={`preview-stats num ${updating ? 'is-updating' : ''}`}>
            {ready && item ? (
              <>
                <span>
                  <span className="muted">Original </span>
                  {INPUT_LABELS[meta.inputFormat]} · {meta.sourceWidth}×{meta.sourceHeight} · {formatBytes(item.file.size)}
                </span>
                <span className="arrow" aria-hidden>→</span>
                {updating ? (
                  <span>
                    <span className="muted">Output </span>
                    {target ?? 'new settings'} · rendering…
                  </span>
                ) : (
                  <>
                    <span>
                      <span className="muted">Output </span>
                      {outLabel} · {meta.width}×{meta.height} · <strong>{formatBytes(meta.size)}</strong>{' '}
                      <span className={meta.size < item.file.size ? 'good' : 'bad'}>{formatDelta(item.file.size, meta.size)}</span>
                    </span>
                    <span className="muted">{formatDuration(meta.ms)}</span>
                  </>
                )}
              </>
            ) : (
              <span className="muted">{item ? 'Rendering…' : ''}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

import { AppHeader, AppHeaderBadge, Button, ThemeToggle } from '@irshadnazree/just-things-ui'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { GeneratorRunner } from './app/generator'
import type { GenerateProgress, GenerateResult } from './app/generator'
import { CancelledError } from './app/pool'
import { handleNavClick } from './app/router'
import { triggerDownload } from './app/sinks'
import { Field, NumberInput, Section, Slider, Toggle } from './components/controls'
import { formatBytes, formatDelta, formatDuration } from './lib/format-bytes'
import { FORMAT_BY_ID } from './lib/formats'
import type { EncodableFormat } from './lib/formats'
import {
  COMPLEXITY_LEVELS,
  DIMENSION_PRESETS,
  MAX_DIMENSION,
  MIN_DIMENSION,
  complexityLabel,
  formatGeneratedFilename,
  parseTargetSize,
  randomSeed,
  validateDimensions,
} from './lib/generate'
import type { SizeUnit } from './lib/generate'

const FORMAT_ORDER: Array<EncodableFormat> = [
  'webp',
  'avif',
  'jpeg',
  'png',
  'jxl',
  'gif',
  'tiff',
  'bmp',
  'ico',
  'qoi',
]

const TARGET_PRESETS: Array<{ label: string; value: string; unit: SizeUnit }> = [
  { label: '100 KB', value: '100', unit: 'KB' },
  { label: '500 KB', value: '500', unit: 'KB' },
  { label: '1 MB', value: '1', unit: 'MB' },
  { label: '5 MB', value: '5', unit: 'MB' },
]

type StoredResult = Omit<GenerateResult, 'preview'>

function drawBitmap(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap) {
  const ctx = canvas?.getContext('bitmaprenderer')
  if (ctx) {
    ctx.transferFromImageBitmap(bitmap)
  } else {
    bitmap.close()
  }
}

function statusBannerText(result: StoredResult): { tone: 'warn' | 'info'; text: string } | null {
  const formatLabel = FORMAT_BY_ID[result.format].label
  if (result.targetBytes === null) { return null }
  const targetLabel = formatBytes(result.targetBytes)
  const actualLabel = formatBytes(result.bytes.byteLength)
  if (result.status === 'too-large') {
    return {
      tone: 'warn',
      text: `Target ${targetLabel} is larger than the maximum achievable size for ${result.width}×${result.height} ${formatLabel} (${actualLabel}). Showing the closest achievable result.`,
    }
  }
  if (result.status === 'too-small') {
    return {
      tone: 'warn',
      text: `Target ${targetLabel} is smaller than the minimum achievable size for ${result.width}×${result.height} ${formatLabel} (${actualLabel}). Showing the closest achievable result.`,
    }
  }
  if (result.status === 'closest') {
    return {
      tone: 'warn',
      text: `Could not reach within ±10% of ${targetLabel} in ${result.attempts} attempts. Showing the closest result (${actualLabel}, ${formatDelta(result.targetBytes, result.bytes.byteLength)}).`,
    }
  }
  if (result.complexityAdjusted) {
    return {
      tone: 'info',
      text: `Adjusted complexity to ${result.complexity} (${complexityLabel(result.complexity).toLowerCase()}) to match the ${targetLabel} target.`,
    }
  }
  return null
}

export default function GeneratePage() {
  const runner = useMemo(() => new GeneratorRunner(), [])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef(0)
  const targetInputId = useId()
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  const [width, setWidth] = useState(1280)
  const [height, setHeight] = useState(720)
  const [complexity, setComplexity] = useState(45)
  const [seed, setSeed] = useState(42)
  const [format, setFormat] = useState<EncodableFormat>('webp')
  const [lossless, setLossless] = useState(false)
  const [targetValue, setTargetValue] = useState('')
  const [targetUnit, setTargetUnit] = useState<SizeUnit>('KB')

  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<GenerateProgress | null>(null)
  const [result, setResult] = useState<StoredResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)

  const formatInfo = FORMAT_BY_ID[format]
  const effectiveLossless = formatInfo.losslessToggle && lossless
  const dimensionError = validateDimensions(width, height)
  const parsedTarget = parseTargetSize(targetValue, targetUnit)
  const canGenerate = dimensionError === null && parsedTarget.error === null

  useEffect(() => () => runner.dispose(), [runner])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) { return }
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!settingsOpen) { return }
    document.documentElement.classList.add('sheet-open')
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.documentElement.classList.remove('sheet-open')
      window.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen])

  const executeGenerate = useCallback(async () => {
    if (!canGenerate) { return }
    const runId = ++runIdRef.current
    setRunning(true)
    setCancelled(false)
    setError(null)
    setProgress(null)
    try {
      const output = await runner.run(
        {
          width,
          height,
          complexity,
          seed,
          format,
          lossless: effectiveLossless,
          targetBytes: parsedTarget.bytes,
        },
        (p) => {
          if (runId === runIdRef.current) { setProgress(p) }
        },
      )
      const { preview, ...stored } = output
      if (runId !== runIdRef.current) {
        preview.close()
        return
      }
      drawBitmap(canvasRef.current, preview)
      setResult(stored)
      setRunning(false)
      setProgress(null)
    } catch (error_) {
      if (runId !== runIdRef.current) { return }
      if (error_ instanceof CancelledError) {
        setRunning(false)
        setProgress(null)
        return
      }
      setError(error_ instanceof Error ? error_.message : String(error_))
      setRunning(false)
      setProgress(null)
    }
  }, [canGenerate, runner, width, height, complexity, seed, format, effectiveLossless, parsedTarget.bytes])

  useEffect(() => {
    if (!canGenerate) { return }
    const timer = setTimeout(() => void executeGenerate(), 300)
    return () => clearTimeout(timer)
  }, [canGenerate, executeGenerate])

  const handleCancel = () => {
    runIdRef.current += 1
    runner.cancel()
    setRunning(false)
    setProgress(null)
    setCancelled(true)
  }

  const filename = result
    ? formatGeneratedFilename(result.width, result.height, result.bytes.byteLength, FORMAT_BY_ID[result.format].ext)
    : null

  const handleDownload = () => {
    if (!result || !filename) { return }
    triggerDownload(new Blob([result.bytes], { type: FORMAT_BY_ID[result.format].mime }), filename)
  }

  const ready = result !== null && !error
  const updating = ready && running
  const banner = result ? statusBannerText(result) : null

  let stageSize: React.CSSProperties | undefined
  if (result && ready) {
    if (zoom === 'actual') {
      stageSize = { width: result.width, height: result.height }
    } else if (viewport.width > 0 && viewport.height > 0) {
      const scale = Math.min(viewport.width / result.width, viewport.height / result.height, 1)
      stageSize = { width: Math.max(1, Math.floor(result.width * scale)), height: Math.max(1, Math.floor(result.height * scale)) }
    }
  }

  const summaryParts = [
    `${width}×${height}`,
    formatInfo.label,
    effectiveLossless ? 'lossless' : null,
    parsedTarget.bytes ? `target ${formatBytes(parsedTarget.bytes)}` : complexityLabel(complexity),
  ].filter(Boolean).join(' · ')

  const progressPct = progress ? (progress.attempt / progress.maxAttempts) * 100 : 0

  return (
    <div className="app">
      <AppHeader
        className="topbar"
        app="image"
        homeHref="/"
        actions={
          <>
            <a href="/" onClick={(e) => handleNavClick(e, '/')}>
              Convert
            </a>
            <a href="/image-preview" onClick={(e) => handleNavClick(e, '/image-preview')}>
              Video frames
            </a>
            <a href="https://github.com/irshadnazree/just-image-things" target="_blank" rel="noreferrer">
              Source
            </a>
            <AppHeaderBadge title="Images are generated with WebAssembly in your browser">
              Runs locally · nothing uploaded
            </AppHeaderBadge>
            <ThemeToggle />
          </>
        }
      />

      <aside className={`sidebar ${settingsOpen ? 'is-open' : ''}`} aria-label="Generator settings">
        <div className="settings">
          <div className="sheet-head">
            <h2>Generator settings</h2>
            <Button variant="primary" onClick={() => setSettingsOpen(false)}>
              Done
            </Button>
          </div>

          <Section title="Dimensions">
            <div className="inline-fields">
              <NumberInput
                label="Width"
                value={width}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                suffix="px"
                onChange={setWidth}
              />
              <span className="times" aria-hidden>×</span>
              <NumberInput
                label="Height"
                value={height}
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                suffix="px"
                onChange={setHeight}
              />
            </div>
            <div className="chip-row">
              {DIMENSION_PRESETS.map((preset) => {
                const active = width === preset.width && height === preset.height
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    className={`chip chip-sm ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      setWidth(preset.width)
                      setHeight(preset.height)
                    }}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
            {dimensionError ? (
              <p className="note error-text" role="alert">
                {dimensionError}
              </p>
            ) : (
              <p className="note num">
                {((width * height) / 1_000_000).toFixed(2)} MP · up to {MAX_DIMENSION.toLocaleString()} px per side, 40 MP max
              </p>
            )}
          </Section>

          <Section title="Colour complexity">
            <Slider
              label="Complexity"
              value={complexity}
              min={0}
              max={100}
              onChange={setComplexity}
              format={(v) => `${v} · ${complexityLabel(v)}`}
              hint="Higher complexity adds colours and fine detail, increasing encoded size."
            />
            <div className="chip-row">
              {COMPLEXITY_LEVELS.map((level) => {
                const active = complexity === level.value
                return (
                  <button
                    key={level.label}
                    type="button"
                    aria-pressed={active}
                    className={`chip chip-sm ${active ? 'is-active' : ''}`}
                    onClick={() => setComplexity(level.value)}
                  >
                    {level.label}
                  </button>
                )
              })}
            </div>
            <Field label="Seed" hint="Same seed and settings always produce the exact same pixels.">
              <div className="seed-row">
                <NumberInput
                  label="Seed"
                  value={seed}
                  min={0}
                  max={2_147_483_647}
                  onChange={setSeed}
                />
                <Button variant="secondary" size="sm" onClick={() => setSeed(randomSeed())}>
                  Randomize
                </Button>
              </div>
            </Field>
          </Section>

          <Section title="Format">
            <div className="format-grid" role="radiogroup" aria-label="Output format">
              {FORMAT_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={format === id}
                  className={`chip ${format === id ? 'is-active' : ''}`}
                  onClick={() => setFormat(id)}
                >
                  {FORMAT_BY_ID[id].label}
                </button>
              ))}
            </div>
            {formatInfo.note && <p className="note">{formatInfo.note}</p>}
            {formatInfo.losslessToggle && (
              <Toggle label="Lossless" checked={lossless} onChange={setLossless} />
            )}
          </Section>

          <Section title="Target file size">
            <div className="field">
              <label className="field-label" htmlFor={targetInputId}>
                Expected size (optional)
              </label>
              <div className="target-size-row">
                <input
                  id={targetInputId}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  placeholder="Default quality"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                />
                <select
                  aria-label="Target size unit"
                  value={targetUnit}
                  onChange={(e) => setTargetUnit(e.target.value as SizeUnit)}
                >
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                </select>
                {targetValue !== '' && (
                  <Button size="sm" variant="ghost" onClick={() => setTargetValue('')}>
                    Clear
                  </Button>
                )}
              </div>
              {parsedTarget.error ? (
                <span className="field-hint error-text" role="alert">
                  {parsedTarget.error}
                </span>
              ) : (
                <span className="field-hint">
                  Leave empty for default quality. Searches quality and complexity to land within ±10%.
                </span>
              )}
            </div>
            <div className="chip-row">
              {TARGET_PRESETS.map((preset) => {
                const active = targetValue === preset.value && targetUnit === preset.unit
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    className={`chip chip-sm ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      setTargetValue(preset.value)
                      setTargetUnit(preset.unit)
                    }}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
          </Section>
        </div>
      </aside>

      <main className="main">
        <div className="preview generate-preview">
          <div className="preview-bar">
            <span className="preview-title">
              Generated image
              {filename && <span className="muted"> · {filename}</span>}
            </span>
            {running && <span className="spinner" aria-label="Generating image" />}
            <span className="spacer" />
            <div className="segmented segmented-sm" role="radiogroup" aria-label="Zoom">
              <button
                type="button"
                role="radio"
                aria-checked={zoom === 'fit'}
                className={zoom === 'fit' ? 'is-active' : ''}
                onClick={() => setZoom('fit')}
              >
                Fit
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={zoom === 'actual'}
                className={zoom === 'actual' ? 'is-active' : ''}
                onClick={() => setZoom('actual')}
              >
                1:1
              </button>
            </div>
            <Button size="sm" variant="primary" disabled={!result || running} onClick={handleDownload}>
              Download
            </Button>
          </div>

          {banner && !running && (
            <div className={`stale-band generate-banner ${banner.tone === 'warn' ? 'is-warn' : ''}`} role="status">
              <span>{banner.text}</span>
            </div>
          )}

          <div ref={viewportRef} className={`preview-viewport zoom-${zoom} ${updating ? 'is-updating' : ''}`}>
            <div className={`preview-stage preview-stage-static ${ready ? 'checker' : ''}`} style={stageSize}>
              <canvas ref={canvasRef} className="preview-canvas preview-canvas-after" hidden={!ready} />
              {error && <div className="preview-message error-text">Failed to generate: {error}</div>}
              {!ready && !error && (
                <div className="preview-message muted">
                  {running ? 'Generating image…' : cancelled ? 'Generation cancelled. Click Generate to run again.' : 'Adjust settings to generate an image.'}
                </div>
              )}
            </div>
          </div>

          <div className={`preview-stats num ${updating ? 'is-updating' : ''}`}>
            {result ? (
              <>
                <span>
                  {result.width}×{result.height} · {FORMAT_BY_ID[result.format].label}
                  {result.lossless ? ' (lossless)' : result.quality !== null ? ` · q=${result.quality}` : ''}
                  {' · '}complexity {result.complexity}
                </span>
                <span>
                  <strong>{formatBytes(result.bytes.byteLength)}</strong>
                  {result.targetBytes !== null && (
                    <>
                      {' '}
                      <span className="muted">/ target {formatBytes(result.targetBytes)}</span>{' '}
                      <span className={result.status === 'matched' ? 'good' : 'bad'}>
                        {formatDelta(result.targetBytes, result.bytes.byteLength)}
                      </span>
                    </>
                  )}
                </span>
                {result.targetBytes !== null && (
                  <span className="muted">
                    {result.attempts} {result.attempts === 1 ? 'attempt' : 'attempts'}
                  </span>
                )}
                <span className="muted">{formatDuration(result.ms)}</span>
              </>
            ) : (
              <span className="muted">
                {running ? 'Working…' : canGenerate ? 'Ready to generate' : 'Fix settings to generate'}
              </span>
            )}
          </div>
        </div>
      </main>

      <div className="run-bar">
        {running ? (
          <>
            <div
              className={`progress ${progress ? '' : 'is-indeterminate'}`}
              role="progressbar"
              aria-label="Generating image"
              aria-valuemin={0}
              aria-valuemax={progress?.maxAttempts ?? 1}
              aria-valuenow={progress?.attempt ?? 0}
            >
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="run-stats num" role="status" aria-live="polite">
              {progress && parsedTarget.bytes !== null ? (
                <>
                  <span>
                    <strong>Attempt {progress.attempt}</strong> of {progress.maxAttempts} · {formatBytes(progress.size)}
                  </span>
                  <span className="muted">
                    Target {formatBytes(parsedTarget.bytes)} · tuning {progress.phase}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    Generating {width}×{height} {formatInfo.label}…
                  </span>
                  <span className="muted">Running locally in a worker</span>
                </>
              )}
            </div>
            <Button className="run-button" onClick={handleCancel}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <div className="run-settings">
              <span className="run-settings-text">{summaryParts}</span>
              <Button size="sm" onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
            </div>
            {cancelled && <p className="notice">Generation cancelled.</p>}
            <Button
              className="run-button"
              variant="primary"
              disabled={!canGenerate}
              onClick={() => void executeGenerate()}
            >
              Generate {formatInfo.label}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

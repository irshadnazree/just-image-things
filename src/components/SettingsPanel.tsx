import { useMemo, useRef, useState } from 'react'
import { useStore } from '../app/store'
import { autoWorkerCount } from '../app/pool'
import { supportsFolderOutput } from '../app/sinks'
import { FORMAT_BY_ID, OUTPUT_FORMATS, type EncodableFormat, type LossyFormat } from '../lib/formats'
import { NAME_TOKENS, renderName } from '../lib/naming'
import { BUILTIN_PRESETS, EFFORT_RANGE, ICO_SIZES, type ResizeMode, type Settings } from '../lib/settings'
import { Field, NumberInput, Section, Segmented, Slider, Toggle } from './controls'

const LOSSY: LossyFormat[] = ['jpeg', 'webp', 'avif', 'jxl']
const isLossy = (f: Settings['format']): f is LossyFormat => (LOSSY as string[]).includes(f)
const hasEffort = (f: Settings['format']): f is keyof Settings['effort'] => f in EFFORT_RANGE

function PresetBar() {
  const presets = useStore((s) => s.presets)
  const applyPreset = useStore((s) => s.applyPreset)
  const savePreset = useStore((s) => s.savePreset)
  const deletePreset = useStore((s) => s.deletePreset)
  const [value, setValue] = useState('')
  const all = [...BUILTIN_PRESETS, ...presets]
  const selected = all.find((p) => p.id === value)

  return (
    <div className="preset-bar">
      <select
        aria-label="Presets"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          const preset = all.find((p) => p.id === e.target.value)
          if (preset) applyPreset(preset)
        }}
      >
        <option value="">Presets…</option>
        <optgroup label="Built-in">
          {BUILTIN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
        {presets.length > 0 && (
          <optgroup label="Yours">
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {selected && !selected.builtin ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            deletePreset(selected.id)
            setValue('')
          }}
        >
          Delete
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const name = prompt('Name this preset')
            if (name?.trim()) savePreset(name.trim())
          }}
        >
          Save
        </button>
      )}
    </div>
  )
}

function FormatSection() {
  const s = useStore((st) => st.settings)
  const update = useStore((st) => st.update)
  const f = s.format
  const info = f === 'original' ? null : FORMAT_BY_ID[f]
  const lossless = (f === 'webp' || f === 'avif' || f === 'jxl') && s.lossless[f]

  return (
    <Section title="Format">
      <div className="format-grid" role="radiogroup" aria-label="Output format">
        {(['original', ...OUTPUT_FORMATS.map((o) => o.id)] as (EncodableFormat | 'original')[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={f === id}
            className={`chip ${f === id ? 'is-active' : ''}`}
            onClick={() => update((d) => void (d.format = id))}
          >
            {id === 'original' ? 'Keep' : FORMAT_BY_ID[id].label}
          </button>
        ))}
      </div>
      {f === 'original' && <p className="note">Each file keeps its format. HEIC becomes JPEG and SVG becomes PNG.</p>}
      {info?.note && <p className="note">{info.note}</p>}

      {f === 'original' &&
        LOSSY.map((lf) => (
          <Slider
            key={lf}
            label={`${FORMAT_BY_ID[lf].label} quality`}
            value={s.quality[lf]}
            min={1}
            max={100}
            onChange={(v) => update((d) => void (d.quality[lf] = v))}
          />
        ))}

      {isLossy(f) && !lossless && (
        <Slider
          label="Quality"
          value={s.quality[f]}
          min={1}
          max={100}
          onChange={(v) => update((d) => void (d.quality[f] = v))}
        />
      )}
      {(f === 'webp' || f === 'avif' || f === 'jxl') && (
        <Toggle label="Lossless" checked={s.lossless[f]} onChange={(v) => update((d) => void (d.lossless[f] = v))} />
      )}
      {hasEffort(f) && (
        <Slider
          label={f === 'png' ? 'Optimisation' : 'Effort'}
          value={s.effort[f]}
          min={EFFORT_RANGE[f].min}
          max={EFFORT_RANGE[f].max}
          hint={EFFORT_RANGE[f].hint}
          onChange={(v) => update((d) => void (d.effort[f] = v))}
        />
      )}
      {f === 'jpeg' && (
        <>
          <Toggle
            label="Progressive"
            checked={s.jpeg.progressive}
            onChange={(v) => update((d) => void (d.jpeg.progressive = v))}
          />
          <Field label="Fill for transparent areas">
            <input
              type="color"
              value={s.jpeg.background}
              onChange={(e) => update((d) => void (d.jpeg.background = e.target.value))}
            />
          </Field>
        </>
      )}
      {(f === 'png' || f === 'gif') && (
        <Field label="Colours" hint={f === 'png' ? 'Fewer colours = much smaller files, like pngquant' : undefined}>
          <select
            value={f === 'png' ? s.png.colors : s.gif.colors}
            onChange={(e) =>
              update((d) => {
                if (f === 'png') d.png.colors = Number(e.target.value)
                else d.gif.colors = Number(e.target.value)
              })
            }
          >
            {f === 'png' && <option value={0}>All (lossless)</option>}
            {[256, 128, 64, 32, 16, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      )}
      {f === 'ico' && (
        <Field label="Icon sizes">
          <div className="chip-row">
            {ICO_SIZES.map((size) => {
              const on = s.ico.sizes.includes(size)
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={on}
                  className={`chip chip-sm ${on ? 'is-active' : ''}`}
                  onClick={() =>
                    update((d) => {
                      d.ico.sizes = on ? d.ico.sizes.filter((x) => x !== size) : [...d.ico.sizes, size].sort((a, b) => a - b)
                      if (!d.ico.sizes.length) d.ico.sizes = [size]
                    })
                  }
                >
                  {size}
                </button>
              )
            })}
          </div>
        </Field>
      )}
    </Section>
  )
}

const RESIZE_MODES: { value: ResizeMode; label: string }[] = [
  { value: 'none', label: 'Keep original size' },
  { value: 'longEdge', label: 'Longest edge' },
  { value: 'maxWidth', label: 'Max width' },
  { value: 'maxHeight', label: 'Max height' },
  { value: 'fit', label: 'Fit inside box' },
  { value: 'percent', label: 'Scale by percent' },
]

function ResizeSection() {
  const r = useStore((st) => st.settings.resize)
  const isIco = useStore((st) => st.settings.format === 'ico')
  const update = useStore((st) => st.update)
  const set = <K extends keyof Settings['resize']>(key: K, v: Settings['resize'][K]) =>
    update((d) => void (d.resize[key] = v))

  return (
    <Section title="Resize">
      {isIco ? (
        <p className="note">Icons are sized by the icon sizes above.</p>
      ) : (
        <>
          <select aria-label="Resize mode" value={r.mode} onChange={(e) => set('mode', e.target.value as ResizeMode)}>
            {RESIZE_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          {r.mode !== 'none' && (
            <div className="inline-fields">
              {r.mode === 'longEdge' && (
                <NumberInput label="Longest edge" value={r.longEdge} onChange={(v) => set('longEdge', v)} suffix="px" />
              )}
              {(r.mode === 'maxWidth' || r.mode === 'fit') && (
                <NumberInput label="Width" value={r.width} onChange={(v) => set('width', v)} suffix="px wide" />
              )}
              {r.mode === 'fit' && <span className="times">×</span>}
              {(r.mode === 'maxHeight' || r.mode === 'fit') && (
                <NumberInput label="Height" value={r.height} onChange={(v) => set('height', v)} suffix="px tall" />
              )}
              {r.mode === 'percent' && (
                <NumberInput label="Percent" value={r.percent} max={1000} onChange={(v) => set('percent', v)} suffix="%" />
              )}
            </div>
          )}
          {r.mode !== 'none' && r.mode !== 'percent' && (
            <Toggle
              label="Allow upscaling"
              hint="Off: smaller images are left alone"
              checked={r.allowUpscale}
              onChange={(v) => set('allowUpscale', v)}
            />
          )}
          {r.mode !== 'none' && (
            <Field label="Filter">
              <select value={r.method} onChange={(e) => set('method', e.target.value as Settings['resize']['method'])}>
                <option value="lanczos3">Lanczos (sharp)</option>
                <option value="mitchell">Mitchell (balanced)</option>
                <option value="catrom">Catmull-Rom</option>
                <option value="triangle">Bilinear (soft)</option>
              </select>
            </Field>
          )}
        </>
      )}
    </Section>
  )
}

function RenameSection() {
  const rename = useStore((st) => st.settings.rename)
  const format = useStore((st) => st.settings.format)
  const sample = useStore((st) => st.items.find((i) => i.id === st.selectedId) ?? st.items[0])
  const update = useStore((st) => st.update)
  const inputRef = useRef<HTMLInputElement>(null)

  const example = useMemo(() => {
    const original = sample?.file.name ?? 'IMG_0042.HEIC'
    const ext = format === 'original' ? original.split('.').pop()!.toLowerCase() : FORMAT_BY_ID[format].ext
    const name = renderName(rename.template, {
      original,
      n: rename.startAt,
      width: 2048,
      height: 1536,
      format: ext,
      date: new Date(),
    })
    return { original, result: `${name}.${ext}` }
  }, [sample, rename, format])

  const insert = (token: string) => {
    const el = inputRef.current
    const t = rename.template
    const start = el?.selectionStart ?? t.length
    const end = el?.selectionEnd ?? t.length
    update((d) => void (d.rename.template = t.slice(0, start) + token + t.slice(end)))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <Section title="Rename">
      <input
        ref={inputRef}
        className="mono"
        aria-label="Name template"
        value={rename.template}
        spellCheck={false}
        onChange={(e) => update((d) => void (d.rename.template = e.target.value))}
      />
      <div className="chip-row">
        {NAME_TOKENS.map((t) => (
          <button key={t.token} type="button" className="chip chip-sm" title={t.label} onClick={() => insert(t.token)}>
            <code>{t.token}</code>
          </button>
        ))}
      </div>
      {/\{n(:\d+)?\}/.test(rename.template) && (
        <div className="inline-fields">
          <span className="field-label">Start at</span>
          <NumberInput label="Start number" value={rename.startAt} min={0} onChange={(v) => update((d) => void (d.rename.startAt = v))} />
        </div>
      )}
      <p className="example">
        <code className="muted">{example.original}</code>
        <span aria-hidden> → </span>
        <code>{example.result}</code>
      </p>
    </Section>
  )
}

function MetadataSection() {
  const m = useStore((st) => st.settings.metadata)
  const update = useStore((st) => st.update)
  return (
    <Section title="Metadata">
      <Segmented
        label="Metadata"
        value={m.keepExif ? 'keep' : 'strip'}
        options={[
          { value: 'strip', label: 'Strip all' },
          { value: 'keep', label: 'Keep EXIF' },
        ]}
        onChange={(v) => update((d) => void (d.metadata.keepExif = v === 'keep'))}
      />
      {m.keepExif ? (
        <>
          <p className="note">Only works for JPEG to JPEG. Other outputs are always stripped.</p>
          <Toggle
            label="Remove location (GPS)"
            checked={m.stripGps}
            onChange={(v) => update((d) => void (d.metadata.stripGps = v))}
          />
        </>
      ) : (
        <p className="note">Camera details, location and other metadata are removed.</p>
      )}
    </Section>
  )
}

function OutputSection() {
  const o = useStore((st) => st.settings.output)
  const workers = useStore((st) => st.settings.workers)
  const folder = useStore((st) => st.outputFolder)
  const chooseFolder = useStore((st) => st.chooseFolder)
  const update = useStore((st) => st.update)
  const set = <K extends keyof Settings['output']>(key: K, v: Settings['output'][K]) =>
    update((d) => void (d.output[key] = v))
  const auto = autoWorkerCount()
  const cores = navigator.hardwareConcurrency || 4

  return (
    <Section title="Output">
      <Segmented
        label="Destination"
        value={o.destination}
        options={[
          {
            value: 'folder',
            label: 'Folder',
            disabled: !supportsFolderOutput,
            title: supportsFolderOutput ? undefined : 'Saving to a folder needs Chrome, Edge or another Chromium browser',
          },
          { value: 'zip', label: 'ZIP' },
          { value: 'files', label: 'Downloads' },
        ]}
        onChange={(v) => set('destination', v)}
      />
      {o.destination === 'folder' && (
        <div className="folder-row">
          <span className={folder ? undefined : 'muted'}>{folder ? `📁 ${folder.name}` : 'No folder chosen'}</span>
          <button type="button" className="btn btn-ghost" onClick={chooseFolder}>
            {folder ? 'Change' : 'Choose…'}
          </button>
        </div>
      )}
      {o.destination === 'files' && <p className="note">Each image downloads on its own. Best for a few files.</p>}
      {o.destination !== 'files' && (
        <Toggle label="Keep subfolders" checked={o.keepStructure} onChange={(v) => set('keepStructure', v)} />
      )}
      <Toggle
        label="Keep original if smaller"
        hint="Same format, same size, and re-encoding didn't help"
        checked={o.skipIfLarger}
        onChange={(v) => set('skipIfLarger', v)}
      />
      {o.destination === 'folder' && (
        <Field label="If a file already exists">
          <select value={o.conflict} onChange={(e) => set('conflict', e.target.value as Settings['output']['conflict'])}>
            <option value="rename">Add a number</option>
            <option value="overwrite">Overwrite it</option>
            <option value="skip">Skip</option>
          </select>
        </Field>
      )}
      <Field label="Parallel workers" hint={`This device reports ${cores} cores. Lowers itself if memory runs out.`}>
        <select value={workers} onChange={(e) => update((d) => void (d.workers = Number(e.target.value)))}>
          <option value={0}>Auto ({auto})</option>
          {Array.from({ length: Math.min(cores, 16) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  )
}

export function SettingsPanel() {
  const running = useStore((s) => s.running)
  return (
    <div className="settings">
      <PresetBar />
      <fieldset disabled={running} className="settings-fields">
        <FormatSection />
        <ResizeSection />
        <RenameSection />
        <MetadataSection />
        <OutputSection />
      </fieldset>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useFreshStats, useStore } from '../app/store'
import { FORMAT_BY_ID } from '../lib/formats'
import { formatDuration } from '../lib/format-bytes'
import type { Settings } from '../lib/settings'
import { DestinationPicker } from './SettingsPanel'

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return now
}

/** One line of the settings that matter most, for phones where the panel is far below. */
function settingsSummary(s: Settings, count: number): string {
  const parts: string[] = []
  const f = s.format
  if (f === 'original') parts.push('Same format')
  else {
    parts.push(FORMAT_BY_ID[f].label)
    if ((f === 'webp' || f === 'avif' || f === 'jxl') && s.lossless[f]) parts.push('lossless')
    else if (f === 'jpeg' || f === 'webp' || f === 'avif' || f === 'jxl') parts.push(`quality ${s.quality[f]}`)
  }
  if (s.resize.mode !== 'none') parts.push('resized')
  const dest = s.output.destination
  parts.push(dest === 'folder' ? 'to a folder' : dest === 'zip' && count > 1 ? 'as ZIP' : 'as downloads')
  return parts.join(' · ')
}

export function RunBar() {
  const count = useStore((s) => s.items.length)
  const running = useStore((s) => s.running)
  const stats = useStore((s) => s.stats)
  const notice = useStore((s) => s.notice)
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const start = useStore((s) => s.start)
  const cancel = useStore((s) => s.cancel)
  const fresh = useFreshStats()
  const now = useNow(running)

  const finished = stats ? stats.done + stats.failed : 0
  const elapsed = stats ? (stats.finishedAt ?? now) - stats.startedAt : 0
  const rate = elapsed > 0 ? finished / (elapsed / 1000) : 0
  const remaining = stats && rate > 0 ? ((stats.total - finished) / rate) * 1000 : 0
  const pct = stats ? (finished / stats.total) * 100 : 0
  // Workers finish together at first, so an estimate from one image or under a second is noise.
  const timeLeft = !finished
    ? 'Starting…'
    : finished < 2 || elapsed < 1000
      ? 'Working…'
      : remaining < 1500
        ? 'Almost done'
        : `About ${formatDuration(remaining)} left`

  const { format } = settings
  const images = `${count.toLocaleString()} ${count === 1 ? 'image' : 'images'}`
  const label = !count
    ? 'Add images to start'
    : fresh
      ? `Convert ${images} again`
      : format === 'original'
        ? `Convert ${images}`
        : `Convert ${images} to ${FORMAT_BY_ID[format].label}`

  return (
    <div className={`run-bar ${count ? '' : 'is-empty'}`}>
      {running && stats ? (
        <>
          <div
            className={`progress ${finished ? '' : 'is-indeterminate'}`}
            role="progressbar"
            aria-label="Converting images"
            aria-valuemin={0}
            aria-valuemax={stats.total}
            aria-valuenow={finished}
          >
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="run-stats num" role="status" aria-live="polite">
            <span>
              <strong>{finished.toLocaleString()}</strong> of {stats.total.toLocaleString()} converted
              {stats.failed > 0 && <span className="error-text"> · {stats.failed} failed</span>}
            </span>
            <span className="muted">{timeLeft}</span>
          </div>
          <button type="button" className="btn btn-block btn-lg" onClick={cancel}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {count > 0 && (
            <div className="run-settings">
              <span className="run-settings-text">{settingsSummary(settings, count)}</span>
              <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
                Settings
              </button>
            </div>
          )}
          {count > 0 && (
            <div className="run-destination">
              <DestinationPicker />
            </div>
          )}
          {notice && !fresh && <p className="notice">{notice}</p>}
          <button
            type="button"
            className={`btn btn-block btn-lg ${fresh ? '' : 'btn-primary'}`}
            disabled={!count}
            onClick={start}
          >
            {label}
          </button>
        </>
      )}
    </div>
  )
}

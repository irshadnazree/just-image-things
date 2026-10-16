import { useEffect, useState } from 'react'
import { useStore } from '../app/store'
import { formatBytes, formatDelta, formatDuration } from '../lib/format-bytes'

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function RunBar() {
  const count = useStore((s) => s.items.length)
  const running = useStore((s) => s.running)
  const stats = useStore((s) => s.stats)
  const notice = useStore((s) => s.notice)
  const destination = useStore((s) => s.settings.output.destination)
  const start = useStore((s) => s.start)
  const cancel = useStore((s) => s.cancel)
  const now = useNow(running)

  const finished = stats ? stats.done + stats.failed : 0
  const elapsed = stats ? (stats.finishedAt ?? now) - stats.startedAt : 0
  const rate = elapsed > 0 ? finished / (elapsed / 1000) : 0
  const remaining = stats && rate > 0 ? ((stats.total - finished) / rate) * 1000 : 0
  const pct = stats ? (finished / stats.total) * 100 : 0

  const verb = destination === 'folder' ? 'Save' : destination === 'zip' && count > 1 ? 'Zip' : 'Download'

  return (
    <div className="run-bar">
      {running && stats ? (
        <>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={stats.total} aria-valuenow={finished}>
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="run-stats num">
            <span>
              <strong>{finished.toLocaleString()}</strong> / {stats.total.toLocaleString()}
              {stats.failed > 0 && <span className="error-text"> · {stats.failed} failed</span>}
            </span>
            <span className="muted">
              {rate.toFixed(1)}/s · {stats.workers} {stats.workers === 1 ? 'worker' : 'workers'}
              {finished > 0 && ` · ${formatDuration(remaining)} left`}
            </span>
          </div>
          <button type="button" className="btn btn-block" onClick={cancel}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {stats?.finishedAt && !stats.cancelled && (
            <div className="run-summary num">
              <span>
                <strong>{stats.done.toLocaleString()}</strong> done in {formatDuration(elapsed)}
                {stats.failed > 0 && <span className="error-text"> · {stats.failed} failed</span>}
              </span>
              {stats.bytesIn > 0 && (
                <span className="muted">
                  {formatBytes(stats.bytesIn)} → {formatBytes(stats.bytesOut)}{' '}
                  <span className={stats.bytesOut < stats.bytesIn ? 'good' : 'bad'}>
                    {formatDelta(stats.bytesIn, stats.bytesOut)}
                  </span>
                </span>
              )}
            </div>
          )}
          {notice && <p className="notice">{notice}</p>}
          <button type="button" className="btn btn-primary btn-block btn-lg" disabled={!count} onClick={start}>
            {count ? `${verb} ${count.toLocaleString()} ${count === 1 ? 'image' : 'images'}` : 'Add images to start'}
          </button>
        </>
      )}
    </div>
  )
}

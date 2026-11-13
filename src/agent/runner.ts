import { runBatch } from '../app/batch'
import { WorkerPool, autoWorkerCount } from '../app/pool'
import type { Sink, WriteOutcome } from '../app/sinks'
import { DEFAULT_SETTINGS, mergeSettings } from '../lib/settings'
import { AGENT_TOKEN_HEADER, type AgentEvent, type AgentJob, type AgentWriteReply } from './protocol'

/**
 * Agent mode: the `bun run agent` CLI serves this page on localhost, opens it in a headless
 * browser and exchanges files with it over HTTP. The page runs the same worker pool and
 * batch logic as the UI; only the input and output ends differ.
 */
export async function runAgent(token: string, root: HTMLElement) {
  root.textContent = 'Agent mode: processing images for the just-image-things CLI…'
  const headers = { [AGENT_TOKEN_HEADER]: token }

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`/__agent/${path}`, { ...init, headers: { ...headers, ...init.headers } })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status} from /__agent/${path}`)
    return res
  }

  // Events are small and ordered. Progress may be dropped on failure; the final event is
  // retried, because without it the CLI can only time out.
  let chain = Promise.resolve()
  const send = (event: AgentEvent, attempts = 1) => {
    chain = chain.then(async () => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await api('event', { method: 'POST', body: JSON.stringify(event) })
          return
        } catch {
          if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    })
    return chain
  }
  window.addEventListener('error', (e) => void send({ type: 'log', message: `Page error: ${e.message}` }))
  window.addEventListener('unhandledrejection', (e) => void send({ type: 'log', message: `Page error: ${String(e.reason)}` }))

  let job: AgentJob
  try {
    job = (await (await api('job')).json()) as AgentJob
  } catch (err) {
    root.textContent =
      'This page is opened by the just-image-things agent CLI (`bun run agent`). Run that instead of visiting it directly.'
    throw err
  }

  const heartbeat = setInterval(() => void send({ type: 'heartbeat' }), 5_000)
  try {
    const settings = mergeSettings(DEFAULT_SETTINGS, job.settings)
    const pool = new WorkerPool(settings.workers || autoWorkerCount())
    pool.onLimitChange = (workers) => void send({ type: 'workers', workers })
    await send({ type: 'ready', workers: pool.limit, userAgent: navigator.userAgent })

    const sink: Sink = {
      async write(path: string, data: ArrayBuffer): Promise<WriteOutcome> {
        const res = await api(`out?path=${encodeURIComponent(path)}`, { method: 'PUT', body: data })
        return (await res.json()) as AgentWriteReply
      },
      async finish() {},
      abort() {},
    }

    const batch = runBatch(
      job.files.map((f, i) => ({
        relPath: f.relPath,
        name: f.name,
        file: async () => {
          const blob = await (await api(`file/${i}`)).blob()
          // Same name and type as a picked file; SVGs only render with image/svg+xml.
          return new File([blob], f.name, { type: blob.type })
        },
      })),
      settings,
      pool,
      sink,
      {
        onStart: (index) => void send({ type: 'start', index }),
        onDone: (index, out) => void send({ type: 'done', index, ...out }),
        onError: (index, message) => void send({ type: 'error', index, message }),
      },
    )
    await batch.done
    pool.dispose()
    clearInterval(heartbeat)
    await send({ type: 'finished' }, 5)
    root.textContent = 'Agent mode: done. You can close this tab.'
  } catch (err) {
    clearInterval(heartbeat)
    await send({ type: 'fatal', message: err instanceof Error ? err.message : String(err) }, 5)
  }
}

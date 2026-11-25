#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { AGENT_TOKEN_HEADER } from '../src/agent/protocol.ts'
import type { AgentEvent, AgentJob, AgentWriteReply } from '../src/agent/protocol.ts'
import { isJunkFile, isSupportedName } from '../src/lib/formats.ts'
import type { ConflictPolicy } from '../src/lib/settings.ts'
import { HELP, parseCli, UsageError } from './options.ts'
import type { CliOptions } from './options.ts'

const ROOT = resolve(import.meta.dirname, '..')
// WARNING: keep in sync with AGENT_SITE_DIR in vite.config.ts.
const SITE_DIR = join(ROOT, 'node_modules/.cache/just-image-things/agent-site')

const STALL_MS = 60_000

const log = (msg: string) => process.stderr.write(`${msg}\n`)

class SetupError extends Error {}

interface InputFile {
  abs: string
  relPath: string
  name: string
  size: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function walk(dir: string, prefix: string, skip: string, out: Array<InputFile>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (abs === skip) { continue }
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) { walk(abs, `${prefix}/${entry.name}`, skip, out) }
    } else if (entry.isFile() && isSupportedName(entry.name)) {
      out.push({ abs, relPath: `${prefix}/${entry.name}`, name: entry.name, size: statSync(abs).size })
    }
  }
}

function collectInputs(paths: Array<string>, outDir: string): Array<InputFile> {
  const files: Array<InputFile> = []
  for (const p of paths) {
    const abs = resolve(p)
    if (!existsSync(abs)) { throw new UsageError(`No such file or folder: ${p}`) }
    const st = statSync(abs)
    if (st.isDirectory()) {
      walk(abs, basename(abs), outDir, files)
    } else if (isSupportedName(basename(abs))) {
      files.push({ abs, relPath: basename(abs), name: basename(abs), size: st.size })
    } else if (!isJunkFile(basename(abs))) {
      throw new UsageError(`Not a supported image: ${p}`)
    }
  }
  const seen = new Set<string>()
  return files
    .filter((f) => (seen.has(f.abs) ? false : (seen.add(f.abs), true)))
    .sort((a, b) => collator.compare(a.relPath, b.relPath))
}

function defaultOutDir(paths: Array<string>): string {
  const first = resolve(paths[0])
  if (paths.length === 1 && statSync(first).isDirectory()) { return `${first}_processed` }
  return join(dirname(first), 'images_processed')
}

function newestMtime(path: string): number {
  if (!existsSync(path)) { return 0 }
  const st = statSync(path)
  if (!st.isDirectory()) { return st.mtimeMs }
  let newest = st.mtimeMs
  for (const entry of readdirSync(path)) { newest = Math.max(newest, newestMtime(join(path, entry))) }
  return newest
}

function ensureSite(force: boolean) {
  const index = join(SITE_DIR, 'index.html')
  if (!force && existsSync(index)) {
    const sources = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'bun.lock']
    const newest = Math.max(...sources.map((s) => newestMtime(join(ROOT, s))))
    if (newest <= statSync(index).mtimeMs) { return }
  }
  log('Building the site for agent mode…')
  const vite = join(ROOT, 'node_modules/vite/bin/vite.js')
  if (!existsSync(vite)) { throw new SetupError('Vite is not installed. Run `bun install` in the just-image-things folder first.') }
  const res = spawnSync(process.execPath, [vite, 'build', '--mode', 'agent', '--logLevel', 'error'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (res.status !== 0) { throw new SetupError('Building the site failed (see errors above).') }
}

function findBrowser(explicit?: string): string | null {
  const wanted = explicit ?? process.env.JIT_BROWSER ?? process.env.CHROME_PATH
  if (wanted) {
    if (!existsSync(wanted)) { throw new SetupError(`Browser not found at ${wanted}`) }
    return wanted
  }
  const candidates: Array<string> = []
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Google Chrome Canary', 'Microsoft Edge', 'Brave Browser', 'Vivaldi']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`, join(process.env.HOME ?? '', `Applications/${app}.app/Contents/MacOS/${app}`))
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as Array<string>
    for (const root of roots) {
      candidates.push(
        join(root, 'Google/Chrome/Application/chrome.exe'),
        join(root, 'Microsoft/Edge/Application/msedge.exe'),
        join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        join(root, 'Chromium/Application/chrome.exe'),
      )
    }
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const which = spawnSync('which', [bin], { encoding: 'utf8' })
      if (which.status === 0 && which.stdout.trim()) { candidates.push(which.stdout.trim()) }
    }
  }
  const pwCache =
    process.platform === 'darwin'
      ? join(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : join(process.env.HOME ?? '', '.cache/ms-playwright')
  if (existsSync(pwCache)) {
    for (const dir of readdirSync(pwCache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      candidates.push(
        join(pwCache, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(pwCache, dir, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
        join(pwCache, dir, 'chrome-linux/chrome'),
        join(pwCache, dir, 'chrome-win/chrome.exe'),
      )
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

function launchBrowser(bin: string, url: string, headed: boolean): { proc: ChildProcess; cleanup: () => void } {
  const profile = mkdtempSync(join(tmpdir(), 'jit-agent-'))
  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--mute-audio',
    ...(headed ? ['--new-window'] : ['--headless=new', '--hide-scrollbars']),
    url,
  ]
  const proc = spawn(bin, args, { stdio: 'ignore' })
  return {
    proc,
    cleanup: () => {
      if (proc.exitCode === null) { proc.kill() }
      // WARNING: Chrome may still hold files for a moment after being killed.
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref()
    },
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

// WARNING: the page needs image/svg+xml to render SVGs, so inputs are sent with their real type.
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.hif': 'image/heif',
  '.jxl': 'image/jxl',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.dib': 'image/bmp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.svg': 'image/svg+xml',
}

function withSuffix(name: string, n: number) {
  const ext = extname(name)
  return ext ? `${name.slice(0, -ext.length)}-${n}${ext}` : `${name}-${n}`
}

const fileId = (st: Stats) => `${st.dev}:${st.ino}`

// WARNING: following a symlinked subfolder could put files outside the output, so refuse anything that isn't a plain folder.
async function ensureOutputDir(outRoot: string, dir: string): Promise<string> {
  let current = outRoot
  for (const part of relative(outRoot, dir).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error }
    }
    if (!(await lstat(current)).isDirectory()) {
      throw new Error(`Refusing to write through ${relative(outRoot, current)}: not a plain folder (symlinks are not followed)`)
    }
  }
  return current
}

async function writeOutput(
  outRoot: string,
  relPath: string,
  data: Buffer,
  conflict: ConflictPolicy,
  inputIds: Set<string>,
): Promise<AgentWriteReply> {
  const target = resolve(outRoot, relPath)
  if (!target.startsWith(outRoot + sep)) { throw new Error(`Refusing to write outside the output folder: ${relPath}`) }
  const dir = await ensureOutputDir(outRoot, dirname(target))
  const rel = (p: string) => relative(outRoot, p).split(sep).join('/')

  if (conflict === 'overwrite') {
    const existing = await lstat(target).catch(() => null)
    if (existing && inputIds.has(fileId(existing))) {
      throw new Error(`Refusing to overwrite the original ${rel(target)}. Use an --out folder that is not the input folder.`)
    }
    // WARNING: write to a temp file, then rename(), which replaces the entry itself and never follows a symlink.
    const tmp = join(dir, `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
    const fh = await open(tmp, 'wx')
    try {
      await fh.writeFile(data)
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
    return { path: rel(target), skipped: false }
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? target : join(dir, withSuffix(basename(target), n))
    try {
      // WARNING: 'wx' fails on any existing entry, including symlinks, so nothing is ever replaced.
      const fh = await open(candidate, 'wx')
      try {
        await fh.writeFile(data)
      } catch (error) {
        await fh.close()
        await rm(candidate, { force: true })
        throw error
      }
      await fh.close()
      return { path: rel(candidate), skipped: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error }
      if (conflict === 'skip') { return { path: rel(target), skipped: true }}
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Array<Buffer> = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
} as const

const staticCache = new Map<string, { body: Buffer; contentType: string; cacheControl: string }>()

async function serveStatic(pathname: string, res: ServerResponse) {
  let file = resolve(SITE_DIR, `.${decodeURIComponent(pathname)}`)
  if (!file.startsWith(SITE_DIR + sep) || !existsSync(file) || statSync(file).isDirectory()) { file = join(SITE_DIR, 'index.html') }
  let entry = staticCache.get(file)
  if (!entry) {
    const isAsset = file.startsWith(join(SITE_DIR, 'assets') + sep)
    entry = {
      body: await readFile(file),
      contentType: MIME[extname(file)] ?? 'application/octet-stream',
      cacheControl: isAsset ? 'public, max-age=3600, immutable' : 'no-store',
    }
    staticCache.set(file, entry)
  }
  res
    .writeHead(200, {
      ...ISOLATION_HEADERS,
      'content-type': entry.contentType,
      'content-length': entry.body.byteLength,
      'cache-control': entry.cacheControl,
    })
    .end(entry.body)
}

interface FileReport {
  input: string
  output?: string
  status: 'pending' | 'done' | 'kept-original' | 'skipped' | 'error'
  inBytes: number
  outBytes?: number
  format?: string
  width?: number
  height?: number
  error?: string
}

function fmtBytes(n: number): string {
  if (n < 1024) { return `${n} B` }
  if (n < 1024 ** 2) { return `${(n / 1024).toFixed(0)} KB` }
  if (n < 1024 ** 3) { return `${(n / 1024 ** 2).toFixed(1)} MB` }
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

async function run(opts: CliOptions): Promise<number> {
  const missing = opts.inputs.find((p) => !existsSync(resolve(p)))
  if (missing) { throw new UsageError(`No such file or folder: ${missing}`) }
  const outDir = resolve(opts.out ?? defaultOutDir(opts.inputs))
  const files = collectInputs(opts.inputs, outDir)
  if (!files.length) { throw new UsageError(`No supported images found in ${opts.inputs.join(', ')}`) }
  const { settings } = opts
  const totalIn = files.reduce((sum, f) => sum + f.size, 0)

  if (opts.dryRun) {
    const plan = { output: outDir, files: files.map((f) => ({ input: f.abs, relPath: f.relPath, bytes: f.size })), settings }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    } else {
      log(`Would process ${files.length} image(s), ${fmtBytes(totalIn)}, into ${outDir}`)
      for (const f of files) { log(`  ${f.relPath}`) }
      log(`Settings: ${JSON.stringify(settings)}`)
    }
    return 0
  }

  ensureSite(opts.rebuild)
  const browserBin = findBrowser(opts.browser)
  if (!browserBin) {
    throw new SetupError(
      'No Chromium-based browser found (Chrome, Chromium, Edge, Brave). Install one, pass --browser <path>, or run `bunx playwright install chromium`.',
    )
  }

  let outRoot: string
  try {
    await mkdir(outDir, { recursive: true })
    outRoot = await realpath(outDir)
    if (!statSync(outRoot).isDirectory()) { throw new Error('not a folder') }
  } catch (error) {
    throw new SetupError(`Can't use ${outDir} as the output folder: ${error instanceof Error ? error.message : error}`)
  }
  const inputIds = new Set<string>()
  for (const f of files) {
    inputIds.add(fileId(statSync(f.abs)))
    inputIds.add(fileId(lstatSync(f.abs)))
  }

  const token = randomBytes(24).toString('hex')
  const job: AgentJob = { settings, files: files.map((f) => ({ relPath: f.relPath, name: f.name, size: f.size })) }
  const reports: Array<FileReport> = files.map((f) => ({ input: f.abs, status: 'pending', inBytes: f.size }))
  const started = Date.now()
  let finished = 0
  let workers = 0

  let settle!: (outcome: { ok: true } | { ok: false; message: string }) => void
  const outcome = new Promise<{ ok: true } | { ok: false; message: string }>((r) => {
    settle = r
  })
  let jobFetched = false
  let lastEventAt = Date.now()

  const handleEvent = (event: AgentEvent) => {
    lastEventAt = Date.now()
    switch (event.type) {
      case 'ready':
        workers = event.workers
        log(`Processing ${files.length} image(s) with ${workers} worker(s) → ${outDir}`)
        break
      case 'workers':
        workers = event.workers
        log(`  (low memory: down to ${workers} worker(s))`)
        break
      case 'start':
      case 'heartbeat':
        break
      case 'done': {
        const r = reports[event.index]
        Object.assign(r, {
          output: join(outDir, event.path),
          status: event.skipped ? 'skipped' : event.kept ? 'kept-original' : 'done',
          outBytes: event.skipped ? undefined : event.size,
          format: event.format,
          width: event.width,
          height: event.height,
          error: event.skipped ? 'Output file already exists (--conflict skip)' : undefined,
        } satisfies Partial<FileReport>)
        finished++
        const note = event.skipped ? 'skipped, exists' : `${fmtBytes(r.inBytes)} → ${fmtBytes(event.size)}${event.kept ? ' (kept original)' : ''}`
        log(`[${finished}/${files.length}] ${files[event.index].relPath} → ${event.path}  ${note}`)
        break
      }
      case 'error':
        Object.assign(reports[event.index], { status: 'error', error: event.message })
        finished++
        log(`[${finished}/${files.length}] ${files[event.index].relPath}  FAILED: ${event.message}`)
        break
      case 'log':
        log(`  page: ${event.message}`)
        break
      case 'finished':
        settle({ ok: true })
        break
      case 'fatal':
        settle({ ok: false, message: event.message })
        break
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/__agent/')) { return await serveStatic(url.pathname, res) }
      if (req.headers[AGENT_TOKEN_HEADER] !== token) {
        res.writeHead(403).end('Bad token')
        return
      }
      const route = url.pathname.slice('/__agent/'.length)
      if (route === 'job' && req.method === 'GET') {
        jobFetched = true
        res.writeHead(200, { ...ISOLATION_HEADERS, 'content-type': 'application/json' }).end(JSON.stringify(job))
      } else if (route.startsWith('file/') && req.method === 'GET') {
        const file = files[Number(route.slice(5))]
        if (!file) { return void res.writeHead(404).end('No such file') }
        const body = await readFile(file.abs)
        res
          .writeHead(200, {
            ...ISOLATION_HEADERS,
            'content-type': IMAGE_MIME[extname(file.name).toLowerCase()] ?? 'application/octet-stream',
            'content-length': body.byteLength,
          })
          .end(body)
      } else if (route === 'out' && req.method === 'PUT') {
        const reply = await writeOutput(
          outRoot,
          url.searchParams.get('path') ?? '',
          await readBody(req),
          settings.output.conflict,
          inputIds,
        )
        res.writeHead(200, { ...ISOLATION_HEADERS, 'content-type': 'application/json' }).end(JSON.stringify(reply))
      } else if (route === 'event' && req.method === 'POST') {
        handleEvent(JSON.parse((await readBody(req)).toString('utf8')) as AgentEvent)
        res.writeHead(204, ISOLATION_HEADERS).end()
      } else {
        res.writeHead(404).end('Unknown route')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) {
        res.writeHead(500).end(message)
      } else {
        res.destroy()
      }
    }
  }
  const server = createServer((req, res) => void handleRequest(req, res))
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r)
  })
  const { port } = server.address() as AddressInfo

  let browser: ReturnType<typeof launchBrowser> | undefined
  const onSignal = () => settle({ ok: false, message: 'Interrupted.' })
  const loadTimer = setTimeout(() => {
    if (!jobFetched) { settle({ ok: false, message: 'The browser did not load the page within 60 seconds.' }) }
  }, 60_000)
  const watchdog = setInterval(() => {
    if (jobFetched && Date.now() - lastEventAt > STALL_MS) {
      settle({ ok: false, message: `The page stopped responding (nothing heard for ${STALL_MS / 1000}s).` })
    }
  }, 5000)
  let result: { ok: true } | { ok: false; message: string }
  try {
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    browser = launchBrowser(browserBin, `http://127.0.0.1:${port}/?agent=${token}`, opts.headed)
    browser.proc.on('exit', (code) => settle({ ok: false, message: `The browser exited unexpectedly (code ${code}).` }))
    browser.proc.on('error', (err) => settle({ ok: false, message: `Could not start ${browserBin}: ${err.message}` }))
    result = await outcome
  } finally {
    clearTimeout(loadTimer)
    clearInterval(watchdog)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    browser?.cleanup()
    server.closeAllConnections()
    server.close()
  }

  const done = reports.filter((r) => r.status === 'done' || r.status === 'kept-original')
  const failed = reports.filter((r) => r.status === 'error')
  const skipped = reports.filter((r) => r.status === 'skipped')
  const pending = reports.filter((r) => r.status === 'pending')
  const bytesIn = done.reduce((s, r) => s + r.inBytes, 0)
  const bytesOut = done.reduce((s, r) => s + (r.outBytes ?? 0), 0)
  const seconds = (Date.now() - started) / 1000

  if (opts.json) {
    const summary = {
      ok: result.ok && !failed.length && !pending.length,
      error: result.ok ? undefined : result.message,
      output: outDir,
      total: files.length,
      done: done.length,
      failed: failed.length,
      skipped: skipped.length,
      notProcessed: pending.length,
      bytesIn,
      bytesOut,
      seconds,
      workers,
      settings,
      files: reports,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    const change = bytesIn ? Math.round((1 - bytesOut / bytesIn) * 100) : 0
    const saved = bytesIn
      ? ` (${fmtBytes(bytesIn)} → ${fmtBytes(bytesOut)}, ${change >= 0 ? `${change}% smaller` : `${-change}% larger`})`
      : ''
    process.stdout.write(
      `${done.length}/${files.length} done${saved}, ${failed.length} failed, ${skipped.length} skipped in ${seconds.toFixed(1)}s → ${outDir}\n`,
    )
  }
  if (!result.ok) {
    log(`Error: ${result.message}`)
    return 2
  }
  return failed.length || pending.length ? 1 : 0
}

async function main() {
  let opts: CliOptions
  try {
    opts = parseCli(process.argv.slice(2), (path) => JSON.parse(readFileSync(resolve(path), 'utf8')))
  } catch (error) {
    log(error instanceof UsageError || error instanceof SyntaxError ? `Error: ${error.message}` : String(error))
    return 2
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  try {
    return await run(opts)
  } catch (error) {
    if (error instanceof UsageError || error instanceof SetupError) {
      log(`Error: ${error.message}`)
      return 2
    }
    throw error
  }
}

process.exitCode = await main()

import { downloadZip } from 'client-zip'
import type { ConflictPolicy } from '../lib/settings'

export type WriteOutcome = { path: string; skipped: boolean }

export interface Sink {
  readonly kind: 'folder' | 'zip' | 'files' | 'agent'
  write(path: string, data: ArrayBuffer): Promise<WriteOutcome>
  finish(): Promise<void>
  abort(): void
}

export const supportsFolderOutput = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const supportsSavePicker = typeof window !== 'undefined' && 'showSaveFilePicker' in window

type PickerWindow = Window & {
  showDirectoryPicker(opts?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<FileSystemDirectoryHandle>
  showSaveFilePicker(opts?: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, Array<string>> }>
  }): Promise<FileSystemFileHandle>
}

export function pickOutputFolder(): Promise<FileSystemDirectoryHandle> {
  return (window as unknown as PickerWindow).showDirectoryPicker({ mode: 'readwrite', id: 'output' })
}

export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission(o: { mode: string }): Promise<PermissionState>
    requestPermission(o: { mode: string }): Promise<PermissionState>
  }
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') { return true }
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
}

function splitPath(path: string) {
  const parts = path.split('/')
  const name = parts.pop() ?? ''
  return { dirs: parts, name }
}

function withSuffix(name: string, n: number) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`
}

/** Writes straight into a folder on disk (Chromium's File System Access API). */
export class FolderSink implements Sink {
  readonly kind = 'folder'
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>()
  private root: FileSystemDirectoryHandle
  private conflict: ConflictPolicy

  constructor(root: FileSystemDirectoryHandle, conflict: ConflictPolicy) {
    this.root = root
    this.conflict = conflict
  }

  private dir(parts: Array<string>): Promise<FileSystemDirectoryHandle> {
    const key = parts.join('/')
    let handle = this.dirs.get(key)
    if (!handle) {
      const last = parts.at(-1)
      handle = last === undefined
        ? Promise.resolve(this.root)
        : this.dir(parts.slice(0, -1)).then((parent) => parent.getDirectoryHandle(last, { create: true }))
      this.dirs.set(key, handle)
    }
    return handle
  }

  async write(path: string, data: ArrayBuffer): Promise<WriteOutcome> {
    const { dirs, name } = splitPath(path)
    const dir = await this.dir(dirs)
    let finalName = name
    if (this.conflict !== 'overwrite') {
      for (let n = 2; await exists(dir, finalName); n++) {
        if (this.conflict === 'skip') { return { path, skipped: true }}
        finalName = withSuffix(name, n)
      }
    }
    const file = await dir.getFileHandle(finalName, { create: true })
    const writable = await file.createWritable()
    await writable.write(data)
    await writable.close()
    return { path: [...dirs, finalName].join('/'), skipped: false }
  }

  async finish() {}
  abort() {}
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: Array<T> = []
  private waiting: ((r: IteratorResult<T>) => void) | null = null
  private closed = false

  push(item: T) {
    if (this.waiting) {
      this.waiting({ value: item, done: false })
      this.waiting = null
    } else {
      this.items.push(item)
    }
  }

  close() {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
    this.waiting = null
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) { return Promise.resolve({ value: item, done: false }) }
        if (this.closed) { return Promise.resolve({ value: undefined, done: true }) }
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}

/**
 * Streams a zip as files finish. With a save picker (Chromium) bytes go straight to disk;
 * elsewhere the browser assembles a Blob, which it may spill to disk for large archives.
 */
export class ZipSink implements Sink {
  readonly kind = 'zip'
  private queue = new AsyncQueue<{ name: string; input: ArrayBuffer; lastModified: Date }>()
  private done: Promise<void>
  private abortController = new AbortController()

  private constructor(fileName: string, target: FileSystemFileHandle | null) {
    const response = downloadZip(this.queue, { buffersAreUTF8: true })
    const body = response.body
    if (target && body) {
      this.done = target
        .createWritable()
        .then((w) => body.pipeTo(w, { signal: this.abortController.signal }))
    } else {
      this.done = response.blob().then((blob) => {
        if (!this.abortController.signal.aborted) { triggerDownload(blob, fileName) }
      })
    }
  }

  /**
   * Must be called from a click handler, before any other await, so the save dialog is allowed.
   * Without `usePicker` the zip is always a plain download (scripted runs have no click to use).
   */
  static async create(fileName: string, usePicker = true): Promise<ZipSink> {
    let target: FileSystemFileHandle | null = null
    if (usePicker && supportsSavePicker) {
      target = await (window as unknown as PickerWindow).showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      })
    }
    return new ZipSink(fileName, target)
  }

  async write(path: string, data: ArrayBuffer): Promise<WriteOutcome> {
    this.queue.push({ name: path, input: data, lastModified: new Date() })
    return { path, skipped: false }
  }

  async finish() {
    this.queue.close()
    await this.done
  }

  abort() {
    this.abortController.abort()
    this.queue.close()
  }
}

export function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** One browser download per file. Fine for a handful, the browser may ask about the rest. */
export class FilesSink implements Sink {
  readonly kind = 'files'
  private chain = Promise.resolve()

  async write(path: string, data: ArrayBuffer): Promise<WriteOutcome> {
    const name = path.split('/').at(-1) ?? path
    // WARNING: space downloads out; browsers silently drop bursts.
    this.chain = this.chain.then(async () => {
      triggerDownload(new Blob([data]), name)
      await new Promise((r) => {
        setTimeout(r, 250)
      })
    })
    await this.chain
    return { path: name, skipped: false }
  }

  async finish() {
    await this.chain
  }

  abort() {}
}

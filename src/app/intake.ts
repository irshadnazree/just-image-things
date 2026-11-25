import { EXTENSION_MAP, isSupportedName } from '../lib/formats'

export interface IntakeFile {
  file: File
  /** Path relative to whatever was dropped or picked, e.g. `trip/day1/a.heic`. */
  relPath: string
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<Array<FileSystemEntry>> {
  return new Promise((resolve, reject) => {
    const all: Array<FileSystemEntry> = []
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(all)
        } else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

async function walkEntry(entry: FileSystemEntry, out: Array<IntakeFile>) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject)
    })
    out.push({ file, relPath: entry.fullPath.replace(/^\//, '') })
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const child of children) { await walkEntry(child, out) }
  }
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<Array<IntakeFile>> {
  // WARNING: grab entries synchronously; the DataTransfer is emptied after the first await.
  const entries = Array.from(dt.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e)
  const out: Array<IntakeFile> = []
  if (entries.length) {
    for (const entry of entries) { await walkEntry(entry, out) }
  } else {
    for (const file of Array.from(dt.files)) { out.push({ file, relPath: file.name }) }
  }
  return out.filter((f) => isSupportedName(f.file.name))
}

/**
 * Starts reading a handle for the first dropped item (Chromium), so save dialogs can open beside it.
 * Must be called synchronously in the drop handler, before `filesFromDataTransfer` or any await.
 */
export function sourceHandleFromDataTransfer(dt: DataTransfer): Promise<FileSystemHandle | null> {
  const item: (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }) | undefined =
    Array.from(dt.items).find((i) => i.kind === 'file')
  const pending = item?.getAsFileSystemHandle?.()
  return pending ? pending.catch(() => null) : Promise.resolve(null)
}

type OpenPickerWindow = Window & {
  showOpenFilePicker(opts: {
    multiple?: boolean
    id?: string
    excludeAcceptAllOption?: boolean
    types?: Array<{ description: string; accept: Record<string, Array<string>> }>
  }): Promise<Array<FileSystemFileHandle>>
  showDirectoryPicker(opts?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<FileSystemDirectoryHandle>
}

/** Chromium's pickers hand back handles, which is what lets the save dialog open next to the source images. */
export const supportsOpenPickers = typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showDirectoryPicker' in window

export interface PickedFiles {
  files: Array<IntakeFile>
  source: FileSystemHandle | null
}

export async function pickImageFiles(): Promise<PickedFiles> {
  const handles = await (window as unknown as OpenPickerWindow).showOpenFilePicker({
    multiple: true,
    id: 'input',
    types: [{ description: 'Images', accept: { 'image/*': Object.keys(EXTENSION_MAP).map((e) => `.${e}`) } }],
  })
  const files = await Promise.all(handles.map((h) => h.getFile()))
  return { files: filesFromList(files), source: handles[0] ?? null }
}

async function walkHandle(dir: FileSystemDirectoryHandle, prefix: string, out: Array<IntakeFile>) {
  const entries = (dir as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()
  for await (const entry of entries) {
    const relPath = `${prefix}/${entry.name}`
    if (entry.kind === 'file') {
      if (isSupportedName(entry.name)) { out.push({ file: await entry.getFile(), relPath }) }
    } else {
      await walkHandle(entry, relPath, out)
    }
  }
}

export async function pickImageFolder(): Promise<PickedFiles> {
  const dir = await (window as unknown as OpenPickerWindow).showDirectoryPicker({ mode: 'read', id: 'input' })
  const files: Array<IntakeFile> = []
  await walkHandle(dir, dir.name, files)
  return { files, source: dir }
}

export function filesFromList(list: FileList | Array<File>): Array<IntakeFile> {
  return Array.from(list)
    .map((file) => ({ file, relPath: file.webkitRelativePath || file.name }))
    .filter((f) => isSupportedName(f.file.name))
}

/** If everything sits under one top-level folder, return its name. */
export function commonRoot(paths: Array<string>): string | null {
  if (!paths.length) { return null }
  let root: string | null = null
  for (const p of paths) {
    const slash = p.indexOf('/')
    if (slash < 0) { return null }
    const first = p.slice(0, slash)
    if (root === null) {
      root = first
    } else if (root !== first) {
      return null
    }
  }
  return root
}

import { isSupportedName } from '../lib/formats'

export interface IntakeFile {
  file: File
  /** Path relative to whatever was dropped or picked, e.g. `trip/day1/a.heic`. */
  relPath: string
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all)
        else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

async function walkEntry(entry: FileSystemEntry, out: IntakeFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ file, relPath: entry.fullPath.replace(/^\//, '') })
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const child of children) await walkEntry(child, out)
  }
}

export async function filesFromDataTransfer(dt: DataTransfer): Promise<IntakeFile[]> {
  // Entries must be grabbed synchronously: the DataTransfer is emptied after the first await.
  const entries = Array.from(dt.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e)
  const out: IntakeFile[] = []
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, out)
  } else {
    for (const file of Array.from(dt.files)) out.push({ file, relPath: file.name })
  }
  return out.filter((f) => isSupportedName(f.file.name))
}

export function filesFromList(list: FileList | File[]): IntakeFile[] {
  return Array.from(list)
    .map((file) => ({ file, relPath: file.webkitRelativePath || file.name }))
    .filter((f) => isSupportedName(f.file.name))
}

/** If everything sits under one top-level folder, return its name. */
export function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null
  let root: string | null = null
  for (const p of paths) {
    const slash = p.indexOf('/')
    if (slash < 0) return null
    const first = p.slice(0, slash)
    if (root === null) root = first
    else if (root !== first) return null
  }
  return root
}

import { useEffect, useRef, useState } from 'react'
import { filesFromDataTransfer, filesFromList } from '../app/intake'
import { useStore } from '../app/store'
import { ACCEPT_ATTR } from '../lib/formats'

export function AddButtons({ compact, disabled }: { compact?: boolean; disabled?: boolean }) {
  const addFiles = useStore((s) => s.addFiles)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(filesFromList(e.target.files))
    e.target.value = ''
  }

  return (
    <>
      <input ref={filesInput} type="file" multiple accept={ACCEPT_ATTR} hidden onChange={onPick} />
      <input
        ref={folderInput}
        type="file"
        hidden
        onChange={onPick}
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />
      <button
        type="button"
        className={compact ? 'btn btn-ghost' : 'btn btn-primary'}
        disabled={disabled}
        onClick={() => filesInput.current?.click()}
      >
        Add files
      </button>
      <button
        type="button"
        className={compact ? 'btn btn-ghost' : 'btn'}
        disabled={disabled}
        onClick={() => folderInput.current?.click()}
      >
        Add folder
      </button>
    </>
  )
}

/** Whole-window drop target and clipboard paste. */
export function DropOverlay() {
  const addFiles = useStore((s) => s.addFiles)
  const running = useStore((s) => s.running)
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setActive(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = running ? 'none' : 'copy'
    }
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setActive(false)
    }
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      if (!running && e.dataTransfer) addFiles(await filesFromDataTransfer(e.dataTransfer))
    }
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (running || target?.closest('input, textarea')) return
      const files = e.clipboardData?.files
      if (!files?.length) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      addFiles(
        filesFromList(
          Array.from(files).map((f) =>
            f.name === 'image.png' ? new File([f], `pasted-${stamp}.png`, { type: f.type, lastModified: Date.now() }) : f,
          ),
        ),
      )
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [addFiles, running])

  if (!active) return null
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay-inner">{running ? 'Wait for the current run to finish' : 'Drop images or folders'}</div>
    </div>
  )
}

export function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-inner">
        <div className="empty-mark" aria-hidden>
          <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="10" width="36" height="28" rx="3" />
            <circle cx="17" cy="20" r="3.5" />
            <path d="M6 32l10-9 8 7 6-5 12 10" />
          </svg>
        </div>
        <h1>Drop images or whole folders</h1>
        <p>
          Convert, compress, resize and rename in bulk. Everything runs on this device, and nothing is uploaded.
        </p>
        <div className="empty-actions">
          <AddButtons />
        </div>
        <p className="formats">
          {['JPEG', 'PNG', 'WebP', 'AVIF', 'HEIC', 'JPEG\u00a0XL', 'TIFF', 'GIF', 'BMP', 'ICO', 'QOI', 'SVG'].join('\u00a0· ')}
        </p>
        <p className="muted small">You can also paste an image with {'⌘V\u00a0/\u00a0Ctrl+V'}.</p>
      </div>
    </div>
  )
}

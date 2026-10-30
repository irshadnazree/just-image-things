import { useEffect } from 'react'
import { useStore } from './app/store'
import { FileList } from './components/FileList'
import { DropOverlay, EmptyState } from './components/Intake'
import { Preview } from './components/Preview'
import { RunBar } from './components/RunBar'
import { SettingsPanel } from './components/SettingsPanel'

export default function App() {
  const hasItems = useStore((s) => s.items.length > 0)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  // The phone settings sheet covers the page: lock the page behind it and let Escape close it.
  useEffect(() => {
    if (!settingsOpen) return
    document.documentElement.classList.add('sheet-open')
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.documentElement.classList.remove('sheet-open')
      window.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen, setSettingsOpen])

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">just image things</span>
        <span className="badge" title="Images are processed with WebAssembly in your browser">
          <span className="badge-dot" aria-hidden />
          Runs locally · nothing uploaded
        </span>
        <span className="spacer" />
        <a className="topbar-link" href="https://github.com/irshadnazree/just-image-things" target="_blank" rel="noreferrer">
          Source
        </a>
      </header>
      <aside className={`sidebar ${settingsOpen ? 'is-open' : ''}`} aria-label="Settings">
        <SettingsPanel />
      </aside>
      <main className="main">
        {hasItems ? (
          <>
            <Preview />
            <FileList />
          </>
        ) : (
          <EmptyState />
        )}
      </main>
      <RunBar />
      <DropOverlay />
    </div>
  )
}

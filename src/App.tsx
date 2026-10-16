import { useStore } from './app/store'
import { FileList } from './components/FileList'
import { DropOverlay, EmptyState } from './components/Intake'
import { Preview } from './components/Preview'
import { RunBar } from './components/RunBar'
import { SettingsPanel } from './components/SettingsPanel'

export default function App() {
  const hasItems = useStore((s) => s.items.length > 0)

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
      <aside className="sidebar">
        <SettingsPanel />
        <RunBar />
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
      <DropOverlay />
    </div>
  )
}

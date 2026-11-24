import { Suspense, lazy } from 'react'
import App from './App.tsx'
import { isGeneratePath, usePathname } from './app/router'

const GeneratePage = lazy(() => import('./GeneratePage.tsx'))

export function Router() {
  const pathname = usePathname()
  if (isGeneratePath(pathname)) {
    return (
      <Suspense fallback={<div className="page-loading muted">Loading generator…</div>}>
        <GeneratePage />
      </Suspense>
    )
  }
  return <App />
}

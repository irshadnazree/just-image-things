import { Suspense, lazy, useEffect } from 'react'
import App from './App.tsx'
import { isGeneratePath, usePathname } from './app/router'
import { applyRouteSeo } from './app/seo'

const GeneratePage = lazy(() => import('./GeneratePage.tsx'))

export function Router() {
  const pathname = usePathname()

  useEffect(() => {
    applyRouteSeo(pathname)
  }, [pathname])

  if (isGeneratePath(pathname)) {
    return (
      <Suspense fallback={<div className="page-loading muted">Loading generator…</div>}>
        <GeneratePage />
      </Suspense>
    )
  }
  return <App />
}

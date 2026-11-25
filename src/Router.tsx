import { Suspense, lazy, useEffect } from 'react'
import App from './App.tsx'
import { isGeneratePath, isImagePreviewPath, usePathname } from './app/router'
import { applyRouteSeo } from './app/seo'

const GeneratePage = lazy(() => import('./GeneratePage.tsx'))
const ImagePreviewPage = lazy(() => import('./ImagePreviewPage.tsx'))

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
  if (isImagePreviewPath(pathname)) {
    return (
      <Suspense fallback={<div className="page-loading muted">Loading video frame parser…</div>}>
        <ImagePreviewPage />
      </Suspense>
    )
  }
  return <App />
}

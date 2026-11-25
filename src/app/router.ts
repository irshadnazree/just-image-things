import { useSyncExternalStore } from 'react'
import type { MouseEvent } from 'react'

export function isGeneratePath(pathname: string): boolean {
  return /^\/generate\/?$/.test(pathname)
}

export function isImagePreviewPath(pathname: string): boolean {
  return /^\/image-preview\/?$/.test(pathname)
}

export function navigate(to: string) {
  if (location.pathname === to) { return }
  history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function handleNavClick(event: MouseEvent<HTMLAnchorElement>, to: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return
  }
  event.preventDefault()
  navigate(to)
}

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback)
  return () => window.removeEventListener('popstate', callback)
}

function getSnapshot() {
  return location.pathname
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

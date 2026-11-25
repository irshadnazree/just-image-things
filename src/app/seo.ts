import { isGeneratePath } from './router'

const SITE_ORIGIN = 'https://image.ruxera.com'

export interface RouteSeo {
  title: string
  description: string
  canonical: string
  ogDescription: string
}

export const HOME_SEO: RouteSeo = {
  title: 'just image things — Batch Image Converter, Compressor & Resizer',
  description:
    'Batch convert, compress, resize & rename HEIC, WebP, AVIF, JPEG XL, PNG, JPEG, SVG & ICO locally in your browser with WebAssembly. Free, private, no uploads.',
  canonical: `${SITE_ORIGIN}/`,
  ogDescription:
    'Batch convert, compress, resize & rename HEIC, WebP, AVIF, JPEG XL, PNG, JPEG, SVG & ICO locally in your browser with WebAssembly. Nothing is uploaded.',
}

export const GENERATE_SEO: RouteSeo = {
  title: 'Test Image Generator by Size & Format — just image things',
  description:
    'Generate deterministic test images locally by dimensions, complexity, seed, and target file size in WebP, AVIF, JPEG, PNG, JXL, GIF, TIFF, BMP, ICO, or QOI.',
  canonical: `${SITE_ORIGIN}/generate`,
  ogDescription:
    'Generate deterministic test images locally in your browser by dimensions, colour complexity, seed, format, and target file size. Nothing is uploaded.',
}

export function seoForPath(pathname: string): RouteSeo {
  return isGeneratePath(pathname) ? GENERATE_SEO : HOME_SEO
}

function setMeta(selector: string, content: string) {
  const el = document.querySelector<HTMLMetaElement>(selector)
  if (el) { el.content = content }
}

/** Keep document title, canonical URL, and social tags aligned with client-side route transitions. */
export function applyRouteSeo(pathname: string) {
  const seo = seoForPath(pathname)
  document.title = seo.title
  setMeta('meta[name="description"]', seo.description)
  setMeta('meta[property="og:title"]', seo.title)
  setMeta('meta[property="og:description"]', seo.ogDescription)
  setMeta('meta[property="og:url"]', seo.canonical)
  setMeta('meta[name="twitter:title"]', seo.title)
  setMeta('meta[name="twitter:description"]', seo.ogDescription)
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (canonical) { canonical.href = seo.canonical }
}

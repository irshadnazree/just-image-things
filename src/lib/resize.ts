import type { Settings } from './settings'

export interface Size {
  width: number
  height: number
}

/** Work out the output size for a resize setting, or null when the image should stay as-is. */
export function targetSize(width: number, height: number, r: Settings['resize']): Size | null {
  let scale: number
  switch (r.mode) {
    case 'none':
      return null
    case 'maxHeight':
      scale = r.height / height
      break
    case 'maxWidth':
      scale = r.width / width
      break
    case 'longEdge':
      scale = r.longEdge / Math.max(width, height)
      break
    case 'fit':
      scale = Math.min(r.width / width, r.height / height)
      break
    case 'percent':
      scale = r.percent / 100
      break
  }
  if (!Number.isFinite(scale) || scale <= 0) return null
  if (scale > 1 && !r.allowUpscale && r.mode !== 'percent') return null
  const out = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
  if (out.width === width && out.height === height) return null
  return out
}

/** Largest size that fits inside a square of `side` while keeping the aspect ratio. */
export function containInSquare(width: number, height: number, side: number): Size {
  const scale = side / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

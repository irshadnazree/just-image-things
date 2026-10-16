import { targetSize } from '../lib/resize'
import type { Settings } from '../lib/settings'

/**
 * Workers have no DOM, so SVGs are drawn here. Vectors are rendered directly at the
 * output size (upscaling is free), which keeps them sharp.
 */
export async function rasterizeSvg(file: Blob, settings: Settings): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    let width = img.naturalWidth || 1024
    let height = img.naturalHeight || 1024
    if (settings.format === 'ico') {
      const side = Math.max(...settings.ico.sizes, 32)
      const scale = side / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    } else {
      const size = targetSize(width, height, { ...settings.resize, allowUpscale: true })
      if (size) ({ width, height } = size)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render SVG'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

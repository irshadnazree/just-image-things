import type { ResizeMethod } from '../lib/settings'

export async function resizeImage(img: ImageData, width: number, height: number, method: ResizeMethod): Promise<ImageData> {
  const resize = (await import('@jsquash/resize')).default
  return resize(img, { width, height, method, fitMethod: 'stretch', premultiply: true, linearRGB: true })
}

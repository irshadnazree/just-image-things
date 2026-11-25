import { hasAlpha } from '../lib/codecs/bmp'
import { resizeRgba } from '../lib/codecs/resize'
import type { ResizeMethod } from '../lib/settings'

export async function resizeImage(
  img: ImageData,
  width: number,
  height: number,
  method: ResizeMethod,
  knownAlpha?: boolean,
): Promise<ImageData> {
  if (img.width === width && img.height === height) { return img }
  const alpha = knownAlpha ?? hasAlpha(img)
  const out = resizeRgba(img, width, height, method, alpha)
  return new ImageData(out, width, height)
}

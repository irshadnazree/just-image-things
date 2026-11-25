import type { ResizeMethod } from '../settings'
import type { RGBAImage } from './bmp'

const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const s = i / 255
  SRGB_TO_LINEAR[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const LINEAR_LUT_SIZE = 4096
const LINEAR_TO_SRGB = new Uint8Array(LINEAR_LUT_SIZE + 1)
for (let i = 0; i <= LINEAR_LUT_SIZE; i++) {
  const l = i / LINEAR_LUT_SIZE
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
  LINEAR_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)))
}

const INV_255 = 1 / 255

function triangleKernel(x: number): number {
  const ax = Math.abs(x)
  return ax < 1 ? 1 - ax : 0
}

function catromKernel(x: number): number {
  const ax = Math.abs(x)
  if (ax < 1) { return (1.5 * ax - 2.5) * ax * ax + 1 }
  if (ax < 2) { return ((-0.5 * ax + 2.5) * ax - 4) * ax + 2 }
  return 0
}

function mitchellKernel(x: number): number {
  const ax = Math.abs(x)
  if (ax < 1) { return ((7 * ax - 12) * ax * ax + 16 / 3) / 6 }
  if (ax < 2) { return ((((-7 / 3) * ax + 12) * ax - 20) * ax + 32 / 3) / 6 }
  return 0
}

function lanczos3Kernel(x: number): number {
  const ax = Math.abs(x)
  if (ax === 0) { return 1 }
  if (ax >= 3) { return 0 }
  const px = Math.PI * ax
  const px3 = px / 3
  return (Math.sin(px) / px) * (Math.sin(px3) / px3)
}

const FILTERS: Record<ResizeMethod, { radius: number; kernel: (x: number) => number }> = {
  triangle: { radius: 1, kernel: triangleKernel },
  catrom: { radius: 2, kernel: catromKernel },
  mitchell: { radius: 2, kernel: mitchellKernel },
  lanczos3: { radius: 3, kernel: lanczos3Kernel },
}

interface FilterTable {
  starts: Int32Array
  lengths: Int32Array
  weights: Float32Array
  maxTaps: number
}

function buildFilterTable(srcLen: number, dstLen: number, radius: number, kernel: (x: number) => number): FilterTable {
  const ratio = srcLen / dstLen
  const scale = ratio > 1 ? ratio : 1
  const support = radius * scale
  const maxTaps = Math.max(1, Math.min(srcLen, Math.ceil(support * 2) + 2))
  const starts = new Int32Array(dstLen)
  const lengths = new Int32Array(dstLen)
  const weights = new Float32Array(dstLen * maxTaps)

  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * ratio - 0.5
    let left = Math.max(0, Math.ceil(center - support))
    let right = Math.min(srcLen - 1, Math.floor(center + support))
    if (right < left) {
      left = Math.max(0, Math.min(srcLen - 1, Math.round(center)))
      right = left
    }
    starts[i] = left
    const count = right - left + 1
    lengths[i] = count
    let sum = 0
    const base = i * maxTaps
    for (let j = 0; j < count; j++) {
      const w = kernel((left + j - center) / scale)
      weights[base + j] = w
      sum += w
    }
    if (sum !== 0) {
      const inv = 1 / sum
      for (let j = 0; j < count; j++) { weights[base + j] *= inv }
    } else {
      weights[base] = 1
      lengths[i] = 1
    }
  }

  return { starts, lengths, weights, maxTaps }
}

function linearToSrgbByte(v: number): number {
  if (v <= 0) { return 0 }
  if (v >= 1) { return 255 }
  return LINEAR_TO_SRGB[(v * LINEAR_LUT_SIZE + 0.5) | 0]
}

/**
 * Separable linear-RGB image resizer using a streaming ring buffer so intermediate
 * rows stay hot in CPU cache instead of allocating a full-frame float buffer.
 */
export function resizeRgba(
  img: RGBAImage,
  dstW: number,
  dstH: number,
  method: ResizeMethod,
  premultiply: boolean,
): Uint8ClampedArray<ArrayBuffer> {
  const { width: srcW, height: srcH, data: src } = img
  const { radius, kernel } = FILTERS[method]
  const hTab = buildFilterTable(srcW, dstW, radius, kernel)
  const vTab = buildFilterTable(srcH, dstH, radius, kernel)

  const hStarts = hTab.starts
  const hLens = hTab.lengths
  const hWeights = hTab.weights
  const hTaps = hTab.maxTaps

  const vStarts = vTab.starts
  const vLens = vTab.lengths
  const vWeights = vTab.weights
  const vTaps = vTab.maxTaps

  const out = new Uint8ClampedArray(new ArrayBuffer(dstW * dstH * 4))
  const ringRows = Math.min(srcH, vTaps + 1)

  if (!premultiply) {
    const dstStride = dstW * 3
    const linRow = new Float32Array(srcW * 3)
    const ring = new Float32Array(ringRows * dstStride)
    const rowAcc = new Float32Array(dstStride)
    let nextSrcY = 0

    const computeHorizontalRow = (sy: number) => {
      let sOff = sy * srcW * 4
      const sEnd = sOff + srcW * 4
      let lOff = 0
      for (; sOff < sEnd; sOff += 4) {
        linRow[lOff] = SRGB_TO_LINEAR[src[sOff]]
        linRow[lOff + 1] = SRGB_TO_LINEAR[src[sOff + 1]]
        linRow[lOff + 2] = SRGB_TO_LINEAR[src[sOff + 2]]
        lOff += 3
      }
      let dstOff = (sy % ringRows) * dstStride
      for (let x = 0; x < dstW; x++) {
        const len = hLens[x]
        let wOff = x * hTaps
        let pOff = hStarts[x] * 3
        let r = 0
        let g = 0
        let b = 0
        for (let j = 0; j < len; j++) {
          const w = hWeights[wOff++]
          r += linRow[pOff] * w
          g += linRow[pOff + 1] * w
          b += linRow[pOff + 2] * w
          pOff += 3
        }
        ring[dstOff] = r
        ring[dstOff + 1] = g
        ring[dstOff + 2] = b
        dstOff += 3
      }
    }

    for (let y = 0; y < dstH; y++) {
      const start = vStarts[y]
      const len = vLens[y]
      const end = start + len
      while (nextSrcY < end) {
        computeHorizontalRow(nextSrcY++)
      }

      let wOff = y * vTaps
      const w0 = vWeights[wOff++]
      let rOff = (start % ringRows) * dstStride
      for (let i = 0; i < dstStride; i++) {
        rowAcc[i] = ring[rOff + i] * w0
      }
      for (let j = 1; j < len; j++) {
        const w = vWeights[wOff++]
        rOff = ((start + j) % ringRows) * dstStride
        for (let i = 0; i < dstStride; i++) {
          rowAcc[i] += ring[rOff + i] * w
        }
      }

      let outOff = y * dstW * 4
      for (let i = 0; i < dstStride; i += 3) {
        out[outOff] = linearToSrgbByte(rowAcc[i])
        out[outOff + 1] = linearToSrgbByte(rowAcc[i + 1])
        out[outOff + 2] = linearToSrgbByte(rowAcc[i + 2])
        out[outOff + 3] = 255
        outOff += 4
      }
    }
    return out
  }

  const dstStride = dstW * 4
  const linRow = new Float32Array(srcW * 4)
  const ring = new Float32Array(ringRows * dstStride)
  const rowAcc = new Float32Array(dstStride)
  let nextSrcY = 0

  const computeHorizontalRowAlpha = (sy: number) => {
    let sOff = sy * srcW * 4
    const sEnd = sOff + srcW * 4
    let lOff = 0
    for (; sOff < sEnd; sOff += 4) {
      const a = src[sOff + 3] * INV_255
      linRow[lOff] = SRGB_TO_LINEAR[src[sOff]] * a
      linRow[lOff + 1] = SRGB_TO_LINEAR[src[sOff + 1]] * a
      linRow[lOff + 2] = SRGB_TO_LINEAR[src[sOff + 2]] * a
      linRow[lOff + 3] = a
      lOff += 4
    }
    let dstOff = (sy % ringRows) * dstStride
    for (let x = 0; x < dstW; x++) {
      const len = hLens[x]
      let wOff = x * hTaps
      let pOff = hStarts[x] * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let j = 0; j < len; j++) {
        const w = hWeights[wOff++]
        r += linRow[pOff] * w
        g += linRow[pOff + 1] * w
        b += linRow[pOff + 2] * w
        a += linRow[pOff + 3] * w
        pOff += 4
      }
      ring[dstOff] = r
      ring[dstOff + 1] = g
      ring[dstOff + 2] = b
      ring[dstOff + 3] = a
      dstOff += 4
    }
  }

  for (let y = 0; y < dstH; y++) {
    const start = vStarts[y]
    const len = vLens[y]
    const end = start + len
    while (nextSrcY < end) {
      computeHorizontalRowAlpha(nextSrcY++)
    }

    let wOff = y * vTaps
    const w0 = vWeights[wOff++]
    let rOff = (start % ringRows) * dstStride
    for (let i = 0; i < dstStride; i++) {
      rowAcc[i] = ring[rOff + i] * w0
    }
    for (let j = 1; j < len; j++) {
      const w = vWeights[wOff++]
      rOff = ((start + j) % ringRows) * dstStride
      for (let i = 0; i < dstStride; i++) {
        rowAcc[i] += ring[rOff + i] * w
      }
    }

    let outOff = y * dstW * 4
    for (let i = 0; i < dstStride; i += 4) {
      const a = rowAcc[i + 3]
      if (a <= 0) {
        out[outOff] = 0
        out[outOff + 1] = 0
        out[outOff + 2] = 0
        out[outOff + 3] = 0
      } else {
        const invA = 1 / a
        out[outOff] = linearToSrgbByte(rowAcc[i] * invA)
        out[outOff + 1] = linearToSrgbByte(rowAcc[i + 1] * invA)
        out[outOff + 2] = linearToSrgbByte(rowAcc[i + 2] * invA)
        out[outOff + 3] = a >= 1 ? 255 : Math.round(a * 255)
      }
      outOff += 4
    }
  }
  return out
}

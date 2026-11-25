export type PaletteColor = [number, number, number] | [number, number, number, number]

export interface QuantizeOptions {
  alpha: boolean
  oneBitAlpha: boolean
}

export interface QuantizeResult {
  palette: Array<PaletteColor>
  index: Uint8Array
  transparentIndex: number
}

interface Box {
  start: number
  end: number
  count: number
  rMin: number
  rMax: number
  gMin: number
  gMax: number
  bMin: number
  bMax: number
  aMin: number
  aMax: number
  axis: number
  score: number
}

function makeBox(
  bins: Int32Array,
  counts: Uint32Array,
  start: number,
  end: number,
  shift: number,
  withAlpha: boolean,
): Box {
  let rMin = 255, rMax = 0
  let gMin = 255, gMax = 0
  let bMin = 255, bMax = 0
  let aMin = 255, aMax = 0
  let count = 0
  const mask = (1 << (8 - shift)) - 1
  const s1 = 8 - shift
  const s2 = s1 * 2
  const s3 = s1 * 3

  for (let i = start; i < end; i++) {
    const k = bins[i]
    count += counts[k]
    const r = (k >>> s2) & mask
    const g = (k >>> s1) & mask
    const b = k & mask
    if (r < rMin) { rMin = r }
    if (r > rMax) { rMax = r }
    if (g < gMin) { gMin = g }
    if (g > gMax) { gMax = g }
    if (b < bMin) { bMin = b }
    if (b > bMax) { bMax = b }
    if (withAlpha) {
      const a = (k >>> s3) & mask
      if (a < aMin) { aMin = a }
      if (a > aMax) { aMax = a }
    }
  }

  const rRange = rMax - rMin
  const gRange = gMax - gMin
  const bRange = bMax - bMin
  const aRange = withAlpha ? aMax - aMin : 0

  let axis = 0
  let maxRange = rRange
  if (gRange > maxRange) {
    maxRange = gRange
    axis = 1
  }
  if (bRange > maxRange) {
    maxRange = bRange
    axis = 2
  }
  if (aRange > maxRange) {
    maxRange = aRange
    axis = 3
  }

  const score = end - start > 1 && maxRange > 0 ? count * (maxRange * maxRange) : 0
  return { start, end, count, rMin, rMax, gMin, gMax, bMin, bMax, aMin, aMax, axis, score }
}

function splitBox(
  box: Box,
  bins: Int32Array,
  counts: Uint32Array,
  scratchBins: Int32Array,
  bucketCounts: Int32Array,
  bucketOffsets: Int32Array,
  shift: number,
  withAlpha: boolean,
): [Box, Box] | null {
  const s1 = 8 - shift
  const mask = (1 << s1) - 1
  const axisShift = box.axis === 0 ? s1 * 2 : box.axis === 1 ? s1 : box.axis === 2 ? 0 : s1 * 3
  const minVal = box.axis === 0 ? box.rMin : box.axis === 1 ? box.gMin : box.axis === 2 ? box.bMin : box.aMin
  const maxVal = box.axis === 0 ? box.rMax : box.axis === 1 ? box.gMax : box.axis === 2 ? box.bMax : box.aMax
  const span = maxVal - minVal + 1
  if (span <= 1) { return null }

  bucketCounts.fill(0, 0, span)
  const bucketPixels = new Float64Array(span)

  for (let i = box.start; i < box.end; i++) {
    const k = bins[i]
    const v = ((k >>> axisShift) & mask) - minVal
    bucketCounts[v]++
    bucketPixels[v] += counts[k]
  }

  let acc = 0
  let offset = box.start
  for (let v = 0; v < span; v++) {
    bucketOffsets[v] = offset
    offset += bucketCounts[v]
  }

  for (let i = box.start; i < box.end; i++) {
    const k = bins[i]
    const v = ((k >>> axisShift) & mask) - minVal
    scratchBins[bucketOffsets[v]++] = k
  }
  bins.set(scratchBins.subarray(box.start, box.end), box.start)

  const half = box.count * 0.5
  let splitIdx = box.start
  let leftBins = 0
  for (let v = 0; v < span - 1; v++) {
    acc += bucketPixels[v]
    leftBins += bucketCounts[v]
    if (leftBins > 0 && acc >= half) {
      splitIdx = box.start + leftBins
      break
    }
  }
  if (splitIdx <= box.start) {
    let firstNonEmpty = 0
    while (firstNonEmpty < span - 1 && bucketCounts[firstNonEmpty] === 0) { firstNonEmpty++ }
    splitIdx = box.start + bucketCounts[firstNonEmpty]
  }
  if (splitIdx >= box.end) {
    let lastNonEmpty = span - 1
    while (lastNonEmpty > 0 && bucketCounts[lastNonEmpty] === 0) { lastNonEmpty-- }
    splitIdx = box.end - bucketCounts[lastNonEmpty]
  }
  if (splitIdx <= box.start || splitIdx >= box.end) { return null }

  return [
    makeBox(bins, counts, box.start, splitIdx, shift, withAlpha),
    makeBox(bins, counts, splitIdx, box.end, shift, withAlpha),
  ]
}

function quantizeHistogram(
  bins: Int32Array,
  binCount: number,
  counts: Uint32Array,
  sumR: Float64Array,
  sumG: Float64Array,
  sumB: Float64Array,
  sumA: Float64Array | null,
  maxColors: number,
  shift: number,
): { palette: Array<PaletteColor>; binToPalette: Uint8Array; lut: Uint8Array } {
  const withAlpha = sumA !== null
  const histSize = counts.length
  const lut = new Uint8Array(histSize)

  if (binCount <= maxColors) {
    const palette: Array<PaletteColor> = new Array<PaletteColor>(binCount)
    const binToPalette = new Uint8Array(binCount)
    for (let i = 0; i < binCount; i++) {
      const k = bins[i]
      const c = counts[k]
      const r = Math.round(sumR[k] / c)
      const g = Math.round(sumG[k] / c)
      const b = Math.round(sumB[k] / c)
      palette[i] = withAlpha ? [r, g, b, Math.round(sumA[k] / c)] : [r, g, b]
      binToPalette[i] = i
      lut[k] = i
    }
    return { palette, binToPalette, lut }
  }

  const boxes: Array<Box> = [makeBox(bins, counts, 0, binCount, shift, withAlpha)]
  const scratchBins = new Int32Array(binCount)
  const bucketCounts = new Int32Array(32)
  const bucketOffsets = new Int32Array(32)

  while (boxes.length < maxColors) {
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].score > bestScore) {
        bestScore = boxes[i].score
        bestIdx = i
      }
    }
    if (bestIdx < 0) { break }
    const pair = splitBox(
      boxes[bestIdx],
      bins,
      counts,
      scratchBins,
      bucketCounts,
      bucketOffsets,
      shift,
      withAlpha,
    )
    if (!pair) {
      boxes[bestIdx].score = 0
      continue
    }
    boxes[bestIdx] = pair[0]
    boxes.push(pair[1])
  }

  const palLen = boxes.length
  const palette: Array<PaletteColor> = new Array<PaletteColor>(palLen)
  const pR = new Int32Array(palLen)
  const pG = new Int32Array(palLen)
  const pB = new Int32Array(palLen)
  const pA = withAlpha ? new Int32Array(palLen) : null
  const binBox = new Uint8Array(binCount)

  for (let b = 0; b < palLen; b++) {
    const box = boxes[b]
    let sr = 0, sg = 0, sb = 0, sa = 0, total = 0
    for (let i = box.start; i < box.end; i++) {
      const k = bins[i]
      total += counts[k]
      sr += sumR[k]
      sg += sumG[k]
      sb += sumB[k]
      if (withAlpha) { sa += sumA[k] }
      binBox[i] = b
    }
    const r = Math.round(sr / total)
    const g = Math.round(sg / total)
    const bl = Math.round(sb / total)
    pR[b] = r
    pG[b] = g
    pB[b] = bl
    if (withAlpha && pA) {
      const a = Math.round(sa / total)
      pA[b] = a
      palette[b] = [r, g, bl, a]
    } else {
      palette[b] = [r, g, bl]
    }
  }

  const binToPalette = new Uint8Array(binCount)
  if (withAlpha && pA) {
    for (let i = 0; i < binCount; i++) {
      const k = bins[i]
      const inv = 1 / counts[k]
      const r = sumR[k] * inv
      const g = sumG[k] * inv
      const bl = sumB[k] * inv
      const a = sumA[k] * inv
      let best = binBox[i]
      let dr = r - pR[best]
      let dg = g - pG[best]
      let db = bl - pB[best]
      let da = a - pA[best]
      let bestDist = dr * dr + dg * dg + db * db + da * da
      for (let j = 0; j < palLen; j++) {
        da = a - pA[j]
        let dist = da * da
        if (dist >= bestDist) { continue }
        dr = r - pR[j]
        dist += dr * dr
        if (dist >= bestDist) { continue }
        dg = g - pG[j]
        dist += dg * dg
        if (dist >= bestDist) { continue }
        db = bl - pB[j]
        dist += db * db
        if (dist < bestDist) {
          bestDist = dist
          best = j
        }
      }
      binToPalette[i] = best
      lut[k] = best
    }
  } else {
    for (let i = 0; i < binCount; i++) {
      const k = bins[i]
      const inv = 1 / counts[k]
      const r = sumR[k] * inv
      const g = sumG[k] * inv
      const bl = sumB[k] * inv
      let best = binBox[i]
      let dr = r - pR[best]
      let dg = g - pG[best]
      let db = bl - pB[best]
      let bestDist = dr * dr + dg * dg + db * db
      for (let j = 0; j < palLen; j++) {
        dr = r - pR[j]
        let dist = dr * dr
        if (dist >= bestDist) { continue }
        dg = g - pG[j]
        dist += dg * dg
        if (dist >= bestDist) { continue }
        db = bl - pB[j]
        dist += db * db
        if (dist < bestDist) {
          bestDist = dist
          best = j
        }
      }
      binToPalette[i] = best
      lut[k] = best
    }
  }

  return { palette, binToPalette, lut }
}

/**
 * Fast median-cut colour quantiser and palette mapper.
 * Uses a 5-bit RGB histogram (32,768 cells) for opaque and 1-bit alpha images,
 * and a 4-bit RGBA histogram (65,536 cells) for full-alpha images.
 */
export function quantizePixels(
  data: Uint8ClampedArray | Uint8Array,
  maxColors: number,
  options: QuantizeOptions,
): QuantizeResult {
  const pixelCount = data.length >>> 2
  const clampedMax = Math.max(2, Math.min(256, Math.round(maxColors)))
  const index = new Uint8Array(pixelCount)
  if (pixelCount === 0) {
    return { palette: [[0, 0, 0]], index, transparentIndex: -1 }
  }

  const u32 =
    data.byteOffset % 4 === 0
      ? new Uint32Array(data.buffer, data.byteOffset, pixelCount)
      : new Uint32Array(data.slice().buffer)

  if (!options.alpha || options.oneBitAlpha) {
    const histSize = 32_768
    const counts = new Uint32Array(histSize)
    const sumR = new Float64Array(histSize)
    const sumG = new Float64Array(histSize)
    const sumB = new Float64Array(histSize)
    let hasTransparent = false

    if (options.oneBitAlpha && options.alpha) {
      for (let i = 0; i < pixelCount; i++) {
        const px = u32[i]
        if ((px >>> 24) <= 127) {
          hasTransparent = true
          continue
        }
        const r = px & 255
        const g = (px >>> 8) & 255
        const b = (px >>> 16) & 255
        const k = ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3)
        counts[k]++
        sumR[k] += r
        sumG[k] += g
        sumB[k] += b
      }
    } else {
      for (let i = 0; i < pixelCount; i++) {
        const px = u32[i]
        const r = px & 255
        const g = (px >>> 8) & 255
        const b = (px >>> 16) & 255
        const k = ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3)
        counts[k]++
        sumR[k] += r
        sumG[k] += g
        sumB[k] += b
      }
    }

    const bins = new Int32Array(histSize)
    let binCount = 0
    for (let k = 0; k < histSize; k++) {
      if (counts[k] > 0) { bins[binCount++] = k }
    }

    if (binCount === 0) {
      return { palette: [[0, 0, 0, 0]], index, transparentIndex: 0 }
    }

    const opaqueLimit = hasTransparent ? Math.max(1, clampedMax - 1) : clampedMax
    const { palette: rgbPalette, lut } = quantizeHistogram(
      bins,
      binCount,
      counts,
      sumR,
      sumG,
      sumB,
      null,
      opaqueLimit,
      3,
    )

    if (hasTransparent) {
      const palette: Array<PaletteColor> = [
        [0, 0, 0, 0],
        ...rgbPalette.map((c): PaletteColor => [c[0], c[1], c[2], 255]),
      ]
      for (let i = 0; i < pixelCount; i++) {
        const px = u32[i]
        if ((px >>> 24) <= 127) {
          index[i] = 0
        } else {
          const r = px & 255
          const g = (px >>> 8) & 255
          const b = (px >>> 16) & 255
          index[i] = lut[((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3)] + 1
        }
      }
      return { palette, index, transparentIndex: 0 }
    }

    for (let i = 0; i < pixelCount; i++) {
      const px = u32[i]
      const r = px & 255
      const g = (px >>> 8) & 255
      const b = (px >>> 16) & 255
      index[i] = lut[((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3)]
    }
    return { palette: rgbPalette, index, transparentIndex: -1 }
  }

  const histSize = 65_536
  const counts = new Uint32Array(histSize)
  const sumR = new Float64Array(histSize)
  const sumG = new Float64Array(histSize)
  const sumB = new Float64Array(histSize)
  const sumA = new Float64Array(histSize)

  for (let i = 0; i < pixelCount; i++) {
    const px = u32[i]
    const r = px & 255
    const g = (px >>> 8) & 255
    const b = (px >>> 16) & 255
    const a = px >>> 24
    const k = ((a >>> 4) << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4)
    counts[k]++
    sumR[k] += r
    sumG[k] += g
    sumB[k] += b
    sumA[k] += a
  }

  const bins = new Int32Array(histSize)
  let binCount = 0
  for (let k = 0; k < histSize; k++) {
    if (counts[k] > 0) { bins[binCount++] = k }
  }

  const { palette, lut } = quantizeHistogram(
    bins,
    binCount,
    counts,
    sumR,
    sumG,
    sumB,
    sumA,
    clampedMax,
    4,
  )

  for (let i = 0; i < pixelCount; i++) {
    const px = u32[i]
    const r = px & 255
    const g = (px >>> 8) & 255
    const b = (px >>> 16) & 255
    const a = px >>> 24
    index[i] = lut[((a >>> 4) << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4)]
  }

  return { palette, index, transparentIndex: -1 }
}

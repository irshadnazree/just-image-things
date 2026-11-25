import { describe, expect, it } from 'vitest'
import { isImagePreviewPath } from '../../app/router'
import { IMAGE_PREVIEW_SEO, seoForPath } from '../../app/seo'
import {
  clampTimeRange,
  computeSampleTimestamps,
  computeThumbnailSize,
  estimateExportArchiveBytes,
  estimateFrameCount,
  formatArchiveFilename,
  formatFrameFilename,
  formatFrameLabel,
  formatTimecode,
  isVideoFile,
  updateFrameSelection,
} from '../video-frames'

describe('video-frames helpers', () => {
  it('detects supported video files and excludes AVI', () => {
    expect(isVideoFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true)
    expect(isVideoFile({ name: 'screen.MKV', type: '' })).toBe(true)
    expect(isVideoFile({ name: 'movie.mov', type: 'application/octet-stream' })).toBe(true)
    expect(isVideoFile({ name: 'legacy.avi', type: 'video/x-msvideo' })).toBe(false)
    expect(isVideoFile({ name: 'photo.png', type: 'image/png' })).toBe(false)
    expect(isVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
  })

  it('formats timecodes with millisecond precision', () => {
    expect(formatTimecode(0)).toBe('00:00.000')
    expect(formatTimecode(1.25)).toBe('00:01.250')
    expect(formatTimecode(65.432)).toBe('01:05.432')
    expect(formatTimecode(3661.5)).toBe('01:01:01.500')
    expect(formatTimecode(-2)).toBe('00:00.000')
  })

  it('formats sanitized frame and archive filenames with zero-padded frame or sample numbers', () => {
    expect(formatFrameFilename('my:clip?.mp4', 7, 'png', 200)).toBe('my-clip--frame-0007.png')
    expect(formatFrameFilename('demo.webm', 42, 'webp', 12_000)).toBe('demo-frame-00042.webp')
    expect(formatFrameFilename('vfr.mp4', 3, 'png', 50, 'sample')).toBe('vfr-sample-0003.png')
    expect(formatArchiveFilename('holiday/trip.mov')).toBe('holiday-trip-frames.zip')
  })

  it('computes aspect-preserving thumbnail sizes without upscaling', () => {
    expect(computeThumbnailSize(1920, 1080, 360)).toEqual({ width: 360, height: 203 })
    expect(computeThumbnailSize(240, 320, 360)).toEqual({ width: 240, height: 320 })
  })

  it('clamps time ranges and handles FPS float and single-point edge cases', () => {
    expect(clampTimeRange(-1, 50, 12)).toEqual({ start: 0, end: 12 })
    expect(clampTimeRange(8, 3, 12)).toEqual({ start: 8, end: 8 })

    const sampled = computeSampleTimestamps(0, 1, 2, 100)
    expect(sampled.truncated).toBe(false)
    expect(sampled.timestamps).toEqual([0, 0.5, 1])

    const thirds = computeSampleTimestamps(0, 1, 3, 100)
    expect(thirds.truncated).toBe(false)
    expect(thirds.timestamps).toHaveLength(4)
    expect(thirds.timestamps[0]).toBe(0)
    expect(thirds.timestamps[3]).toBe(1)

    const single = computeSampleTimestamps(4.5, 4.5, 10, 100)
    expect(single.truncated).toBe(false)
    expect(single.timestamps).toEqual([4.5])

    const capped = computeSampleTimestamps(0, 10, 30, 5)
    expect(capped.truncated).toBe(true)
    expect(capped.timestamps).toHaveLength(5)
  })

  it('distinguishes decoded frame ordinals from sampled ordinals in labels', () => {
    expect(formatFrameLabel(1, 'frame')).toBe('#1')
    expect(formatFrameLabel(1, 'frame', true)).toBe('Frame #1')
    expect(formatFrameLabel(4, 'sample')).toBe('Sample #4')
    expect(formatFrameLabel(4, 'sample', true)).toBe('Sample #4')
  })

  it('supports single toggle and Shift+click range selection', () => {
    const order = [0, 1, 2, 3, 4, 5]
    const s1 = updateFrameSelection(new Set(), null, 1, false, order)
    expect([...s1.next]).toEqual([1])
    expect(s1.nextAnchor).toBe(1)

    const s2 = updateFrameSelection(s1.next, s1.nextAnchor, 4, true, order)
    expect([...s2.next]).toEqual([1, 2, 3, 4])

    const s3 = updateFrameSelection(s2.next, s2.nextAnchor, 2, false, order)
    expect([...s3.next]).toEqual([1, 3, 4])
    expect(s3.nextAnchor).toBe(2)
  })

  it('estimates frame counts across extraction modes and archive byte size', () => {
    const meta = { duration: 10, fps: 30, estimatedFrames: 300 }
    expect(estimateFrameCount(meta, 'all', 2, 5, 0, 10)).toBe(300)
    expect(estimateFrameCount(meta, 'every-n', 2, 5, 0, 10)).toBe(60)
    expect(estimateFrameCount(meta, 'fps', 2, 5, 0, 10)).toBe(21)
    expect(estimateFrameCount(meta, 'fps', 3, 5, 0, 1)).toBe(4)
    expect(estimateFrameCount(meta, 'keyframes', 2, 5, 0, 10)).toBeNull()

    const pngBytes = estimateExportArchiveBytes(3840, 2160, 100, 'png')
    const webpBytes = estimateExportArchiveBytes(3840, 2160, 100, 'webp')
    expect(pngBytes).toBeGreaterThan(webpBytes)
  })

  it('matches /image-preview route and SEO metadata', () => {
    expect(isImagePreviewPath('/image-preview')).toBe(true)
    expect(isImagePreviewPath('/image-preview/')).toBe(true)
    expect(isImagePreviewPath('/generate')).toBe(false)
    expect(seoForPath('/image-preview')).toEqual(IMAGE_PREVIEW_SEO)
  })
})

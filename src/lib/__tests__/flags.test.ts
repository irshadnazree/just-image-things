import { describe, expect, it } from 'vitest'
import { applyFlags, flagsFromInput, flagsFromParams, UsageError } from '../flags'
import { DEFAULT_SETTINGS } from '../settings'

describe('flagsFromParams', () => {
  it('reads short and long names and boolean switches', () => {
    const { flags, unknown } = flagsFromParams(new URLSearchParams('f=webp&q=75&long-edge=1600&lossless&upscale=0&utm_source=x'), ['agent'])
    expect(flags).toEqual({ format: 'webp', quality: '75', 'long-edge': '1600', lossless: true, upscale: false })
    expect(unknown).toEqual(['utm_source'])
  })

  it('skips ignored keys', () => {
    expect(flagsFromParams(new URLSearchParams('agent=abc&save=zip'), ['agent', 'save']).unknown).toEqual([])
  })
})

describe('flagsFromInput', () => {
  it('parses a CLI-style string', () => {
    expect(flagsFromInput('-f webp -q 75 --long-edge=1600 --rename "{name} small" --lossless')).toEqual({
      format: 'webp',
      quality: '75',
      'long-edge': '1600',
      rename: '{name} small',
      lossless: true,
    })
  })

  it('accepts objects with numbers and short names', () => {
    expect(flagsFromInput({ f: 'avif', quality: 50, 'keep-exif': true })).toEqual({ format: 'avif', quality: '50', 'keep-exif': true })
  })

  it('rejects unknown flags and missing values', () => {
    expect(() => flagsFromInput('--nope')).toThrow(UsageError)
    expect(() => flagsFromInput('-f')).toThrow(/needs a value/)
    expect(() => flagsFromInput({ nope: 1 })).toThrow(UsageError)
  })
})

describe('applyFlags', () => {
  it('maps flags onto settings', () => {
    const s = applyFlags({ format: 'webp', quality: '75', 'long-edge': '1600' })
    expect(s.format).toBe('webp')
    expect(s.quality.webp).toBe(75)
    expect(s.resize).toMatchObject({ mode: 'longEdge', longEdge: 1600 })
  })

  it('keeps output settings from the base when a preset is applied', () => {
    const base = { ...DEFAULT_SETTINGS, output: { ...DEFAULT_SETTINGS.output, destination: 'files' as const } }
    const s = applyFlags({ preset: 'heic-jpeg' }, { base })
    expect(s.format).toBe('jpeg')
    expect(s.output.destination).toBe('files')
  })
})

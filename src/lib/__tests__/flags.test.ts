import { describe, expect, it } from 'vitest'
import { parseCli } from '../../../cli/options'
import { applyFlags, flagsFromInput, flagsFromParams, UsageError } from '../flags'
import { DEFAULT_SETTINGS } from '../settings'

const parse = (...args: Array<string>) => parseCli(args)

describe('URL and browser API flags', () => {
  it('reads URL params with short and long names, switches and ignored keys', () => {
    const params = new URLSearchParams('f=webp&q=75&long-edge=1600&lossless&upscale=0&agent=abc&utm_source=x')
    const { flags, unknown } = flagsFromParams(params, ['agent'])
    expect(flags).toEqual({ format: 'webp', quality: '75', 'long-edge': '1600', lossless: true, upscale: false })
    expect(unknown).toEqual(['utm_source'])
  })

  it('parses CLI-style strings and objects, rejecting unknown flags and missing values', () => {
    expect(flagsFromInput('-f webp -q 75 --long-edge=1600 --rename "{name} small" --lossless')).toEqual({
      format: 'webp',
      quality: '75',
      'long-edge': '1600',
      rename: '{name} small',
      lossless: true,
    })
    expect(flagsFromInput({ f: 'avif', quality: 50, 'keep-exif': true })).toEqual({ format: 'avif', quality: '50', 'keep-exif': true })
    expect(() => flagsFromInput('--nope')).toThrow(UsageError)
    expect(() => flagsFromInput('-f')).toThrow(/needs a value/)
    expect(() => flagsFromInput({ nope: 1 })).toThrow(UsageError)
  })

  it('keeps output settings from the base when a preset is applied', () => {
    const base = { ...DEFAULT_SETTINGS, output: { ...DEFAULT_SETTINGS.output, destination: 'files' as const } }
    const s = applyFlags({ preset: 'heic-jpeg' }, { base })
    expect(s.format).toBe('jpeg')
    expect(s.output.destination).toBe('files')
  })
})

describe('parseCli', () => {
  it('defaults to the web app settings', () => {
    expect(parse('photos')).toMatchObject({ inputs: ['photos'], settings: DEFAULT_SETTINGS })
  })

  it('applies quality, lossless and effort to the chosen format, or all of them for original', () => {
    const jpeg = parse('x', '-f', 'jpg', '-q', '70').settings
    expect(jpeg.format).toBe('jpeg')
    expect(jpeg.quality).toEqual({ ...DEFAULT_SETTINGS.quality, jpeg: 70 })

    const avif = parse('x', '-f', 'avif', '--lossless', '--effort', '8').settings
    expect(avif.lossless).toEqual({ webp: false, avif: true, jxl: false })
    expect(avif.effort.avif).toBe(8)

    const original = parse('x', '-f', 'original', '-q', '55', '--effort', '9').settings
    expect(original.quality).toEqual({ jpeg: 55, webp: 55, avif: 55, jxl: 55 })
    expect(original.effort).toEqual({ png: 6, webp: 6, avif: 9, jxl: 9 })
  })

  it('maps resize, output, rename and metadata flags', () => {
    expect(parse('x', '--long-edge', '2048').settings.resize).toMatchObject({ mode: 'longEdge', longEdge: 2048 })
    expect(parse('x', '--fit', '1920x1080').settings.resize).toMatchObject({ mode: 'fit', width: 1920, height: 1080 })
    expect(parse('x', '--scale', '50%').settings.resize).toMatchObject({ mode: 'percent', percent: 50 })
    expect(parse('x', '--max-width', '800', '--upscale').settings.resize).toMatchObject({ mode: 'maxWidth', width: 800, allowUpscale: true })

    const { settings } = parse('x', '--flat', '--conflict', 'skip', '--rename', '{date}-{n:3}', '--start-at', '0', '--keep-exif', '--keep-gps', '--force-reencode')
    expect(settings.output).toMatchObject({ keepStructure: false, conflict: 'skip', skipIfLarger: false })
    expect(settings.rename).toEqual({ template: '{date}-{n:3}', startAt: 0 })
    expect(settings.metadata).toEqual({ keepExif: true, stripGps: false })
  })

  it('layers preset, then config, then flags', () => {
    const { settings } = parseCli(['x', '-p', 'web', '-c', 'cfg.json', '-q', '90'], () => ({ quality: { webp: 40 }, rename: { template: '{n}' } }))
    expect(settings.resize).toMatchObject({ mode: 'longEdge', longEdge: 2048 })
    expect(settings.quality.webp).toBe(90)
    expect(settings.quality.jpeg).toBe(DEFAULT_SETTINGS.quality.jpeg)
    expect(settings.rename.template).toBe('{n}')
  })

  it('rejects bad or conflicting arguments', () => {
    const bad = [
      ['x', '--long-edge', '10', '--scale', '5'],
      ['x', '-f', 'png', '-q', '50'],
      ['x', '-q', '101'],
      ['x', '-f', 'bogus'],
      ['x', '-f', 'webp', '--effort', '7'],
      ['x', '--fit', '1920'],
      ['x', '--keep-gps'],
      ['x', '--ico-sizes', '17'],
      ['x', '--conflict', 'merge'],
      ['x', '--wat'],
      [],
    ]
    for (const args of bad) { expect(() => parse(...args), args.join(' ')).toThrow(UsageError) }
  })
})

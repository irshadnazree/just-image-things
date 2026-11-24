import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/settings.ts'
import { parseCli, UsageError } from '../options.ts'

const parse = (...args: Array<string>) => parseCli(args)

describe('parseCli', () => {
  it('defaults to the web app settings', () => {
    const opts = parse('photos')
    expect(opts.inputs).toEqual(['photos'])
    expect(opts.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('applies quality, lossless and effort to the chosen format only', () => {
    const { settings } = parse('x', '-f', 'jpg', '-q', '70')
    expect(settings.format).toBe('jpeg')
    expect(settings.quality.jpeg).toBe(70)
    expect(settings.quality.webp).toBe(DEFAULT_SETTINGS.quality.webp)

    const avif = parse('x', '-f', 'avif', '--lossless', '--effort', '8').settings
    expect(avif.lossless).toEqual({ webp: false, avif: true, jxl: false })
    expect(avif.effort.avif).toBe(8)
  })

  it('spreads quality across lossy formats for --format original', () => {
    const { settings } = parse('x', '-f', 'original', '-q', '55', '--effort', '9')
    expect(settings.quality).toEqual({ jpeg: 55, webp: 55, avif: 55, jxl: 55 })
    expect(settings.effort).toEqual({ png: 6, webp: 6, avif: 9, jxl: 9 })
  })

  it('maps resize flags onto resize modes', () => {
    expect(parse('x', '--long-edge', '2048').settings.resize).toMatchObject({ mode: 'longEdge', longEdge: 2048 })
    expect(parse('x', '--fit', '1920x1080').settings.resize).toMatchObject({ mode: 'fit', width: 1920, height: 1080 })
    expect(parse('x', '--scale', '50%').settings.resize).toMatchObject({ mode: 'percent', percent: 50 })
    expect(parse('x', '--max-width', '800', '--upscale').settings.resize).toMatchObject({ mode: 'maxWidth', width: 800, allowUpscale: true })
  })

  it('layers preset, then config, then flags', () => {
    const { settings } = parseCli(['x', '-p', 'web', '-c', 'cfg.json', '-q', '90'], () => ({ quality: { webp: 40 }, rename: { template: '{n}' } }))
    expect(settings.resize).toMatchObject({ mode: 'longEdge', longEdge: 2048 })
    expect(settings.quality.webp).toBe(90)
    expect(settings.quality.jpeg).toBe(DEFAULT_SETTINGS.quality.jpeg)
    expect(settings.rename.template).toBe('{n}')
  })

  it('sets output, rename and metadata options', () => {
    const { settings } = parse('x', '--flat', '--conflict', 'skip', '--rename', '{date}-{n:3}', '--start-at', '0', '--keep-exif', '--keep-gps', '--force-reencode')
    expect(settings.output).toMatchObject({ keepStructure: false, conflict: 'skip', skipIfLarger: false })
    expect(settings.rename).toEqual({ template: '{date}-{n:3}', startAt: 0 })
    expect(settings.metadata).toEqual({ keepExif: true, stripGps: false })
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

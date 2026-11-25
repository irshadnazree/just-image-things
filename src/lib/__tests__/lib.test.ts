import { describe, expect, it } from 'vitest'
import { chooseThreading } from '../../app/batch'
import { isSupportedName } from '../formats'
import { outputPath, renderName, reservePath, sanitizeName } from '../naming'
import type { Settings } from '../settings'
import { DEFAULT_SETTINGS, mergeSettings } from '../settings'

const withFormat = (format: Settings['format']): Settings => ({ ...DEFAULT_SETTINGS, format })

describe('inputs, naming and saved settings', () => {
  it('skips junk and unsupported files', () => {
    expect(isSupportedName('IMG_1.HEIC')).toBe(true)
    expect(isSupportedName('._IMG_1.HEIC')).toBe(false)
    expect(isSupportedName('.DS_Store')).toBe(false)
    expect(isSupportedName('raw.CR2')).toBe(false)
  })

  it('renders name tokens, sanitises them and builds unique output paths', () => {
    const ctx = { original: 'IMG_0042.HEIC', n: 7, width: 2048, height: 1536, format: 'webp', date: new Date(2026, 9, 16) }
    expect(renderName('{name}', ctx)).toBe('IMG_0042')
    expect(renderName('holiday-{n:3}', ctx)).toBe('holiday-007')
    expect(renderName('{date}_{n}_{w}x{h}.{fmt}', ctx)).toBe('2026-10-16_7_2048x1536.webp')
    expect(renderName('', ctx)).toBe('IMG_0042')
    expect(sanitizeName('a/b:c*?')).toBe('a-b-c--')
    expect(sanitizeName('  ..  ')).toBe('image')

    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', true, true)).toBe('day1/a.jpg')
    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', true, false)).toBe('trip/day1/a.jpg')
    expect(outputPath('trip/day1/a.heic', 'a', 'jpg', false, true)).toBe('a.jpg')
    const taken = new Set<string>()
    expect(['a.png', 'A.png', 'a.png'].map((p) => reservePath(p, taken))).toEqual(['a.png', 'A-2.png', 'a-3.png'])
  })

  it('fills in keys missing from older saved settings', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { format: 'avif', quality: { jpeg: 50 } as never })
    expect(merged.format).toBe('avif')
    expect(merged.quality.jpeg).toBe(50)
    expect(merged.quality.webp).toBe(DEFAULT_SETTINGS.quality.webp)
  })
})

describe('chooseThreading', () => {
  const env = { canMt: true, cores: 16 }

  it('runs at most one full-pool MT AVIF or JPEG XL encoder, else ST lanes', () => {
    for (const format of ['avif', 'jxl'] as const) {
      expect(chooseThreading(withFormat(format), 2, 15, env)).toEqual({ lanes: 1, mtThreads: 16 })
      expect(chooseThreading(withFormat(format), 100, 15, env)).toEqual({ lanes: 17, mtThreads: 1 })
    }
  })

  it('splits cores between MT oxipng lanes and never uses MT without isolation', () => {
    expect(chooseThreading(withFormat('png'), 2, 15, env)).toEqual({ lanes: 2, mtThreads: 8 })
    expect(chooseThreading(withFormat('png'), 3, 15, env)).toEqual({ lanes: 3, mtThreads: 1 })
    expect(chooseThreading(withFormat('avif'), 1, 4, { canMt: false, cores: 16 })).toEqual({ lanes: 1, mtThreads: 1 })
  })
})

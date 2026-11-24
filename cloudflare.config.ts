import { defineConfig } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'just-image-things',
    compatibilityDate: '2026-10-29',
    assets: { notFoundHandling: 'single-page-application' },
    domains: ['image.ruxera.com'],
  },
})

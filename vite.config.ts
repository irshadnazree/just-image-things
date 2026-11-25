import { resolve } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// WARNING: keep in sync with SITE_DIR in cli/agent.ts.
const AGENT_SITE_DIR = 'node_modules/.cache/just-image-things/agent-site'

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig(({ mode }) => ({
  plugins: mode === 'agent' ? [react()] : [react(), cloudflare()],
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
  build:
    mode === 'agent'
      ? { outDir: AGENT_SITE_DIR, emptyOutDir: true }
      : {
          rollupOptions: {
            input: {
              main: resolve(import.meta.dirname, 'index.html'),
              generate: resolve(import.meta.dirname, 'generate.html'),
              imagePreview: resolve(import.meta.dirname, 'image-preview.html'),
            },
          },
        },
  worker: { format: 'es' },
  // WARNING: the codecs locate their .wasm files via import.meta.url, which pre-bundling breaks.
  optimizeDeps: {
    exclude: [
      '@jsquash/avif',
      '@jsquash/jpeg',
      '@jsquash/jxl',
      '@jsquash/oxipng',
      '@jsquash/png',
      '@jsquash/resize',
      '@jsquash/webp',
    ],
  },
}))

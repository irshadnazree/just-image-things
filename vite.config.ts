import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// WARNING: keep in sync with SITE_DIR in cli/agent.ts.
const AGENT_SITE_DIR = 'node_modules/.cache/just-image-things/agent-site'

export default defineConfig(({ mode }) => ({
  plugins: mode === 'agent' ? [react()] : [react(), cloudflare()],
  build: mode === 'agent' ? { outDir: AGENT_SITE_DIR, emptyOutDir: true } : undefined,
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

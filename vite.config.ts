import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Where `bun run agent` builds the site it serves locally. Keep in sync with cli/agent.ts. */
const AGENT_SITE_DIR = 'node_modules/.cache/just-image-things/agent-site'

export default defineConfig(({ mode }) => ({
  // Agent mode serves a plain static build from the CLI, so it skips the Cloudflare output layout.
  plugins: mode === 'agent' ? [react()] : [react(), cloudflare()],
  build: mode === 'agent' ? { outDir: AGENT_SITE_DIR, emptyOutDir: true } : undefined,
  worker: { format: 'es' },
  // The codecs locate their .wasm files via import.meta.url, which pre-bundling would break.
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

# just image things

Batch convert, compress, resize and rename images in the browser. Everything runs locally with WebAssembly, so nothing is uploaded.

A web rework of [`image-script.py`](https://github.com/irshadnazree/media-related-script/blob/main/image-script.py).

## Formats

| | Read | Write |
|---|:-:|:-:|
| JPEG | ✓ | ✓ (MozJPEG) |
| PNG | ✓ | ✓ (OxiPNG, optional colour reduction) |
| WebP | ✓ | ✓ lossy / lossless |
| AVIF | ✓ | ✓ lossy / lossless |
| JPEG XL | ✓ | ✓ lossy / lossless |
| HEIC / HEIF | ✓ | |
| TIFF | ✓ | ✓ |
| GIF | ✓ (first frame) | ✓ |
| BMP | ✓ | ✓ |
| ICO | ✓ | ✓ (multi-size) |
| QOI | ✓ | ✓ |
| SVG | ✓ (rendered at output size) | |

## Features

- Drop files or whole folders; subfolders are kept in the output.
- Live before/after preview with output size, using the current settings.
- Resize by longest edge, max width/height, fit-in-box or percent. Never upscales unless you ask.
- Rename templates: `{name}`, `{n}`, `{n:3}`, `{w}`, `{h}`, `{date}`, `{fmt}`.
- Metadata stripped by default. Optionally keep EXIF for JPEG to JPEG, with GPS removed.
- EXIF orientation is applied, so phone photos come out upright.
- Keeps the original when re-encoding would make it bigger.
- Output straight to a folder (Chromium), as a streamed ZIP, or as individual downloads.
- Uses every core: a worker pool that shrinks itself if the browser runs out of memory.
- Presets, built-in and your own, stored in the browser.

## Development

Use Node.js 22.23+, 24.22+, or 26.12+ and pnpm (pinned in `package.json`).
The Cloudflare CLI and Vite plugin are pinned beta releases. Review the version-specific release-age exceptions in `pnpm-workspace.yaml` when upgrading them.

```sh
pnpm install
pnpm run dev        # http://localhost:5173
pnpm run test       # unit tests
pnpm run build      # Cloudflare Build Output in .cloudflare/output/v0/
```

Codecs: [jSquash](https://github.com/jamsinclair/jSquash) (Squoosh codecs), [libheif-js](https://github.com/catdad-experiments/libheif-js), [UTIF](https://github.com/photopea/UTIF.js), [gifenc](https://github.com/mattdesl/gifenc), [client-zip](https://github.com/Touffy/client-zip). BMP, ICO, QOI and EXIF handling are in `src/lib`.

## Known limits

- Camera RAW (CR2, NEF, ARW, DNG…) and PSD aren't supported yet.
- Animated GIF/WebP input keeps only the first frame.
- Very large images (above roughly 100–150 megapixels) can exceed browser memory.
- HEIC colour profiles (Display P3) aren't converted outside Safari, so colours can look slightly muted.

## Deploy

Hosted on Cloudflare Workers (static assets) at [image.ruxera.com](https://image.ruxera.com). `cloudflare.config.ts` defines the Worker, custom domain, and SPA fallback. The Cloudflare Vite plugin packages the app as static assets; deployment commands use the Cloudflare `cf` CLI.

```sh
pnpm run deploy                              # build and deploy with cf
pnpm exec cf deploy --prebuilt --mode production --dry-run # validate an existing build without uploading
```

For Workers Builds connected to `main`, use:

- Build command: `pnpm run build`
- Deploy command: `pnpm exec cf deploy --prebuilt --mode production`
- Preview build command: `pnpm run typecheck`
- Preview deploy command: `pnpm exec cf previews deploy --mode production`

The preview deploy command builds with preview intent and uploads to an isolated Worker Preview. Production Build Output cannot be reused with `cf previews deploy --prebuilt`.

Production and preview build variables are `NODE_VERSION=26.12.0` and `PNPM_VERSION=12.14.0`. These remote settings are managed through `cf builds workers update` or the Cloudflare dashboard; repository changes do not update them automatically.

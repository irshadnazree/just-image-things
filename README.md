# just image things

Batch convert, compress, resize, rename, and generate images in the browser at [image.ruxera.com](https://image.ruxera.com). Everything runs locally with WebAssembly, so nothing is uploaded.

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
- Metadata stripped from re-encoded files by default. Optionally keep EXIF for JPEG to JPEG, with GPS removed. A non-JPEG original kept because re-encoding would make it bigger is copied byte-for-byte, metadata included (use `--force-reencode` to always strip).
- EXIF orientation is applied, so phone photos come out upright.
- Keeps the original when re-encoding would make it bigger.
- Output straight to a folder (Chromium), as a streamed ZIP, or as individual downloads.
- Uses every core: a worker pool that shrinks itself if the browser runs out of memory.
- Presets, built-in and your own, stored in the browser.
- Shareable link settings (`?f=webp&q=75&long-edge=1600`) that apply for that visit only.
- **Test image generator** ([`/generate`](https://image.ruxera.com/generate)): synthesize deterministic test images locally by dimensions (up to 8192×8192 / 40 MP), colour complexity, seed, format, and optional target file size (±10% search).
- **Video frame extractor** ([`/image-preview`](https://image.ruxera.com/image-preview)): inspect every frame of MP4, MOV, WebM, and MKV videos locally using hardware-accelerated WebCodecs (`mediabunny`) in a Web Worker, copy any full-resolution frame to clipboard, or batch download selected frames as PNG, WebP, or JPEG (ZIP, folder, or individual files).

## Agents and the command line

AI agents and scripts can run the same pipeline either **in the browser** or **from the command line**:

- **Browser scripting API & WebMCP**: open `https://image.ruxera.com/?f=webp&q=75&long-edge=1600`, attach files to `input#jit-files`, and evaluate `await window.justImageThings.run()` to receive a JSON report and download the results. Browsers supporting WebMCP (`navigator.modelContext`) also expose `convert_images` and `list_queued_images`.
- **LLM documentation**: hosted at [`/llms.txt`](https://image.ruxera.com/llms.txt) and [`/llms-full.txt`](https://image.ruxera.com/llms-full.txt).
- **Headless CLI**: `bun run agent` builds the site, serves it on `127.0.0.1`, opens it in headless Chrome, Chromium, Edge or Brave, and writes results straight to disk. Images still never leave your machine.

```sh
bun run agent ~/Pictures/trip -f webp -q 75 --long-edge 2048
bun run agent ~/Pictures/iphone --preset heic-jpeg -o ~/Desktop/jpegs
bun run agent shots/ -f avif --rename "{date}-{n:3}" --json   # JSON report on stdout
bun run agent --help                                          # every option
```

Output goes to `<folder>_processed` unless you pass `-o`. Originals are never touched. See [AGENTS.md](AGENTS.md) for the full agent guide and flag mapping.

## Development

Use Bun 1.4.2 (pinned in `package.json`) for installs and project commands. The Cloudflare CLI runs under Node.js and requires Node.js 22.23+, 24.22+, or 26.12+; do not force it to run with `bun --bun`.
The Cloudflare CLI and Vite plugin are pinned beta releases.

```sh
bun install
bun run dev        # http://localhost:5173
bun run test       # unit tests
bun run build      # Cloudflare Build Output in .cloudflare/output/v0/
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
bun run deploy                              # build and deploy with cf
bun x --no-install cf deploy --prebuilt --mode production --dry-run # validate an existing build without uploading
```

For Workers Builds connected to `main`, use:

- Build command: `bun run build`
- Deploy command: `bun x --no-install cf deploy --prebuilt --mode production`
- Preview build command: `bun run typecheck`
- Preview deploy command: `bun x --no-install cf previews deploy --mode production`

The preview deploy command builds with preview intent and uploads to an isolated Worker Preview. Production Build Output cannot be reused with `cf previews deploy --prebuilt`.

Production and preview build variables are `NODE_VERSION=26.12.0` and `BUN_VERSION=1.4.2`. These remote settings are managed through `cf builds workers update` or the Cloudflare dashboard; repository changes do not update them automatically.

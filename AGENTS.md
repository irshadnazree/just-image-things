# Agent guide

## Processing a user's images

There are two ways for an AI agent to process images with `just image things`. Both run the exact same local WebAssembly pipeline (`runBatch`) and never upload images to any server.

### Option 1: Headless CLI (from this repository)

Use the agent CLI when you have shell access in this checkout. It builds the web app (`vite build --mode agent`), serves it on `127.0.0.1` with a per-run token, runs it in headless Chrome/Chromium/Edge/Brave, and writes outputs straight to disk.

```sh
bun install                      # once
bun run agent --help             # every option
bun run agent <folder-or-files...> [options] --json
```

- Originals are never modified (even `--conflict overwrite` refuses to overwrite an input file, symlinks inside input folders are skipped, and outputs are never written through symlinks; symlinks passed explicitly as arguments are read).
- Output goes to `<folder>_processed` next to a single input folder (or `./images_processed` for loose files); override with `-o <dir>`.
- Subfolder structure is preserved (`--flat` to flatten). Existing outputs get `-2`, `-3`… unless `--conflict overwrite|skip`.
- Always pass `--json` when invoking programmatically: a structured JSON report is printed to `stdout`, while progress goes to `stderr`.
- Run `--dry-run --json` first on large or unfamiliar folders to inspect matched files and resolved settings without launching a browser.
- Layering order when combining options: defaults → `--preset` → `--config <file.json>` → explicit CLI flags.
- Exit codes: `0` all done, `1` some files failed (inspect `files[].error` in JSON report), `2` bad arguments or setup/browser error.
- Requirements: Bun and a Chromium-based browser (auto-detected: Chrome, Chromium, Edge, Brave, Vivaldi, or Playwright Chromium cache). If none is found, pass `--browser <path>`, set `JIT_BROWSER`, or run `bunx playwright install chromium`.

### Option 2: Live website with a browser tool (zero UI clicking)

When using a browser automation tool (Playwright, Puppeteer, CDP, etc.) without a local clone, do not click through the settings UI:

1. Open `https://image.ruxera.com/?f=webp&q=75&long-edge=1600` (URL flags apply for this visit only without overwriting saved preferences).
2. Attach local image paths to the hidden automation input `input#jit-files`.
3. Evaluate `await window.justImageThings.run()` (or pass flags as a CLI string or object, e.g. `await window.justImageThings.run("-f avif -q 55 --long-edge 1920", { save: "zip" })`).
4. Read the returned JSON `RunReport` (`{ ok, cancelled, saved, total, failed, bytesIn, bytesOut, ms, files }`) and collect the downloaded file(s). `save` defaults to `"files"` for ≤10 images and `"zip"` for >10 images.

- Other API helpers: `justImageThings.configure(flags)`, `justImageThings.files()`, `justImageThings.settings()`, `justImageThings.clear()`, `justImageThings.help`.
- Browsers supporting WebMCP (`navigator.modelContext`) also get `convert_images` (`{ flags?, save? }`) and `list_queued_images` (`{}`) automatically.
- Full hosted agent documentation: `https://image.ruxera.com/llms.txt` and `https://image.ruxera.com/llms-full.txt`.

### Generating synthetic test images

To generate deterministic placeholder or QA test images by dimensions (up to `8192×8192`, `40 MP` max), colour complexity (`0–100`), seed, output format, and optional target file size (±10% binary search), direct users to `https://image.ruxera.com/generate`.

### Mapping requests to flags

The same flag names work in the CLI (`--long-edge 1600`), URL params (`?long-edge=1600`), and `window.justImageThings.run(...)`.

| Request | Flags |
|---|---|
| "convert to WebP/AVIF/JPEG/PNG/JPEG XL/GIF/TIFF/BMP/ICO/QOI" | `-f webp` / `avif` / `jpeg` (`jpg`) / `png` / `jxl` (`jpegxl`) / `gif` / `tiff` (`tif`) / `bmp` / `ico` / `qoi` |
| "compress, keep the format" | `-f original` (or `--preset compress`; optionally `-q 75`; HEIC→JPEG, SVG→PNG) |
| "iPhone HEIC to JPEG" | `--preset heic-jpeg` (JPEG q=90) |
| "optimize for the web" | `--preset web` (WebP q=80, longest edge 2048px) |
| "smallest file size" | `--preset avif` (AVIF q=60; optionally `--effort 6`) |
| "favicon" | `--preset favicon` (or `-f ico --ico-sizes 16,32,48,256`) |
| "smaller / higher quality" | `-q 0-100` (defaults: jpeg 82, webp 80, avif 60, jxl 75) |
| "lossless" | `--lossless` (webp, avif, jxl) |
| "stronger compression / effort" | `--effort <n>` (png 0–6, webp 0–6, avif 0–10, jxl 1–9) |
| "reduce PNG/GIF colours" | `--colors <n>` (png: 0 or 2–256; gif: 2–256) |
| "transparent background for JPEG / baseline JPEG" | `--background #ffffff`, `--no-progressive` |
| "force re-encode even if bigger" | `--force-reencode` (by default, original bytes are kept if larger) |
| "max 1920 wide" / "max 1080 tall" / "longest side 2048" / "fit 1920x1080" / "half size" | `--max-width 1920` / `--max-height 1080` / `--long-edge 2048` / `--fit 1920x1080` / `--scale 50` (pick one; never upscales without `--upscale`, except `--scale`, which always applies its percentage; filter `--resize-method lanczos3\|mitchell\|catrom\|triangle`) |
| "rename to 001, 002…" | `--rename "{n:3}"` (tokens: `{name} {n} {n:3} {w} {h} {date} {fmt}`; `--start-at 1`) |
| "keep EXIF" / "keep GPS too" | `--keep-exif` (JPEG→JPEG only; GPS stripped unless `--keep-gps` is also passed) |
| "flatten subfolders / handle existing files" | `--flat`, `--conflict rename\|overwrite\|skip` |
| "limit parallelism / JSON config file" | `--workers 1-64`, `-c settings.json` (CLI only) |

## Working on the code

- Run `bun run test`, `bun run typecheck`, and `bun run lint` before committing (and `bun run build` when changing Vite/HTML/Cloudflare config).
- Linting uses `oxlint` with `@cloudflare/oxlint-config` and `@interfere/landmines` (`landmines/no-comments: error` disallows casual inline `//` comments in TS/TSX — use JSDoc `/** ... */` or `// WARNING: ...` only where genuinely warranted).
- Image processing lives in `src/worker/` (`decode.ts`, `resize.ts`, `encode.ts`, `generate.ts`, `processor.worker.ts`) and `src/app/batch.ts` (naming, output paths). Both the UI (`src/app/store.ts`) and headless agent mode (`src/agent/runner.ts`) go through `runBatch`, so keep batch behaviour changes there.
- Test image generation lives in `src/lib/generate.ts` (PRNG, pixel synthesis, target-size binary search), `src/worker/generate.ts`, `src/app/generator.ts`, and `src/GeneratePage.tsx` (routed at `/generate` via `src/Router.tsx` and `src/app/router.ts`).
- Video frame extraction lives in `src/lib/video-frames.ts`, `src/worker/video.worker.ts` (WebCodecs + `mediabunny`), `src/app/video-engine.ts` (worker bridge + `<video>` fallback), `src/components/FrameGrid.tsx`, `src/components/FrameLightbox.tsx`, and `src/ImagePreviewPage.tsx` (routed at `/image-preview`).
- Settings flags (`--long-edge 1600`, `?long-edge=1600`) are defined once in `src/lib/flags.ts` and shared by the CLI (`cli/options.ts`), URL link settings, and `window.justImageThings` (`src/app/agent-api.ts`). When adding or renaming a flag, preset, or format, update `public/llms.txt`, `public/llms-full.txt`, `AGENTS.md`, `cli/options.ts`, and `src/app/agent-api.ts`.
- Static SEO & agent discovery assets live in `index.html`, `generate.html`, `image-preview.html`, `src/app/seo.ts`, and `public/` (`llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `og-image.png`, `_headers`).
- The headless CLI lives in `cli/`: `options.ts` parses flags into `Settings` (`src/lib/settings.ts`), and `agent.ts` builds the site with `vite build --mode agent`, serves it on `127.0.0.1`, and exchanges files with the page.

# Agent guide

## Processing a user's images

To convert, compress, resize or rename a folder of images, use the agent CLI. It runs this web app in headless Chrome/Chromium/Edge/Brave and writes the results to disk, so the output matches what the website produces with the same settings.

```sh
bun install                      # once
bun run agent --help             # every option
bun run agent <folder-or-files...> [options] --json
```

- Originals are never modified. By default output goes to `<folder>_processed` next to the input; use `-o <dir>` to choose.
- Subfolders are kept (`--flat` to drop them). Existing output files get `-2`, `-3`… unless `--conflict overwrite|skip`.
- Add `--json` to get a report on stdout (per-file output path, size, dimensions, status, errors). Progress goes to stderr.
- Use `--dry-run` first on large or unfamiliar folders to see what will be picked up.
- Exit code: `0` all done, `1` some files failed (see the report), `2` bad arguments or setup problem.

Mapping requests to flags:

| Request | Flags |
|---|---|
| "convert to WebP/AVIF/JPEG/PNG/JPEG XL" | `-f webp` / `avif` / `jpeg` / `png` / `jxl` |
| "compress, keep the format" | `-f original` (optionally `-q 70`) |
| "iPhone HEIC to JPEG" | `--preset heic-jpeg` |
| "for the web" | `--preset web` (WebP, longest edge 2048) |
| "smaller/higher quality" | `-q 0-100` (defaults: jpeg 82, webp 80, avif 60, jxl 75) |
| "lossless" | `--lossless` (webp, avif, jxl) |
| "max 1920 wide" / "longest side 2048" / "fit 1920x1080" / "half size" | `--max-width 1920` / `--long-edge 2048` / `--fit 1920x1080` / `--scale 50` |
| "rename to 001, 002…" | `--rename "{n:3}"` (tokens: `{name} {n} {n:3} {w} {h} {date} {fmt}`) |
| "keep EXIF" | `--keep-exif` (JPEG→JPEG only; GPS still stripped unless `--keep-gps`) |
| "favicon" | `-f ico --ico-sizes 16,32,48,256` |

Requirements: Bun and a Chromium-based browser. If none is found, pass `--browser <path>` or run `bunx playwright install chromium`.

## Working on the code

- `bun run test`, `bun run typecheck`, `bun run lint` before committing.
- Image work happens in `src/worker/` (decode, resize, encode) and `src/app/batch.ts` (naming, output paths). The UI (`src/app/store.ts`) and agent mode (`src/agent/runner.ts`) both go through `runBatch`, so keep behaviour changes there.
- Settings flags (`--long-edge 1600`, `?long-edge=1600`) are defined once in `src/lib/flags.ts` and shared by the CLI, link settings and the page's `window.justImageThings` API (`src/app/agent-api.ts`).
- The CLI lives in `cli/`: `options.ts` maps flags to the app's `Settings` (`src/lib/settings.ts`), `agent.ts` builds the site with `vite build --mode agent`, serves it on 127.0.0.1 and exchanges files with the page.

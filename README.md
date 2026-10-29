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

```sh
bun install
bun run dev        # http://localhost:5173
bun run test       # unit tests
bun run build      # static site in dist/
```

Codecs: [jSquash](https://github.com/jamsinclair/jSquash) (Squoosh codecs), [libheif-js](https://github.com/catdad-experiments/libheif-js), [UTIF](https://github.com/photopea/UTIF.js), [gifenc](https://github.com/mattdesl/gifenc), [client-zip](https://github.com/Touffy/client-zip). BMP, ICO, QOI and EXIF handling are in `src/lib`.

## Known limits

- Camera RAW (CR2, NEF, ARW, DNG…) and PSD aren't supported yet.
- Animated GIF/WebP input keeps only the first frame.
- Very large images (above roughly 100–150 megapixels) can exceed browser memory.
- HEIC colour profiles (Display P3) aren't converted outside Safari, so colours can look slightly muted.

## Deploy

Hosted on Cloudflare Workers (static assets) at [image.ruxera.com](https://image.ruxera.com), configured in `wrangler.jsonc`. Workers Builds deploys every push to `main`; `bun run deploy` deploys by hand.

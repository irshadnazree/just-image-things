declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    is_primary(): boolean
    has_alpha_channel(): boolean
    display(target: ImageData, callback: (result: ImageData | null) => void): void
    free(): void
  }
  interface LibHeif {
    heif_context_free(context: unknown): void
    HeifDecoder: new () => { decoder: unknown; decode(data: Uint8Array): Array<HeifImage> }
  }
  const factory: (options?: Record<string, unknown>) => LibHeif | Promise<LibHeif>
  export default factory
}

declare module 'gifenc' {
  type Palette = Array<Array<number>>
  type ColorFormat = 'rgb565' | 'rgb444' | 'rgba4444'
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: ColorFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: ColorFormat): Uint8Array
  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: Palette; transparent?: boolean; transparentIndex?: number; delay?: number; repeat?: number },
    ): void
    finish(): void
    bytes(): Uint8Array
  }
}

declare module '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js' {
  export default function init(moduleOrPath?: unknown): Promise<unknown>
  export function optimise(data: Uint8Array, level: number, interlace: boolean, optimiseAlpha: boolean): Uint8Array
  export function optimise_raw(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    level: number,
    interlace: boolean,
    optimiseAlpha: boolean,
  ): Uint8Array
}

declare module '@jsquash/oxipng/codec/pkg-parallel/squoosh_oxipng.js' {
  export default function init(moduleOrPath?: unknown): Promise<unknown>
  export function initThreadPool(numThreads: number): Promise<void>
  export function optimise(data: Uint8Array, level: number, interlace: boolean, optimiseAlpha: boolean): Uint8Array
  export function optimise_raw(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    level: number,
    interlace: boolean,
    optimiseAlpha: boolean,
  ): Uint8Array
}

declare module '@jsquash/avif/codec/enc/avif_enc.js' {
  const factory: (options?: Record<string, unknown>) => Promise<{
    encode(data: Uint8Array, width: number, height: number, options: Record<string, unknown>): Uint8Array | null
  }>
  export default factory
}

declare module '@jsquash/jxl/codec/enc/jxl_enc.js' {
  const factory: (options?: Record<string, unknown>) => Promise<{
    encode(data: Uint8ClampedArray, width: number, height: number, options: Record<string, unknown>): Uint8Array | null
  }>
  export default factory
}

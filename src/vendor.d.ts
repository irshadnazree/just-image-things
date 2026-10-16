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
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] }
  }
  const factory: (options?: Record<string, unknown>) => LibHeif | Promise<LibHeif>
  export default factory
}

declare module 'gifenc' {
  type Palette = number[][]
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

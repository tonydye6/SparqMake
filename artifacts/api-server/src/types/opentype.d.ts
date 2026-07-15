// Minimal local typings for opentype.js — the published @types package pulls
// in the DOM lib (`/// <reference lib="dom" />`), which breaks Node fetch
// typings across the whole server. We only use a small surface.
declare module "opentype.js" {
  export interface RenderOptions {
    kerning?: boolean;
  }

  export interface Path {
    toPathData(decimalPlaces?: number): string;
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    getPath(text: string, x: number, y: number, fontSize: number, options?: RenderOptions): Path;
    getAdvanceWidth(text: string, fontSize: number, options?: RenderOptions): number;
  }

  export function parse(buffer: ArrayBuffer): Font;

  const opentype: { parse: typeof parse };
  export default opentype;
}

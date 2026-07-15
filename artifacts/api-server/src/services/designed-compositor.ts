import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import opentype, { type Font as OTFont } from "opentype.js";
import type { DesignSpec, DesignFont } from "./design-spec.js";

// Deterministic renderer for the designed-graphic pipeline. Takes a DesignSpec
// (from the LLM art-director stage) plus a subject cutout and assembles a real
// multi-layer composited graphic: background field → panels → subject cutout →
// display typography (rendered as SVG paths from bundled OFL fonts — crisp,
// never AI-drawn) → logo → data strip → texture pass.

const SHARP_LIMITS = { limitInputPixels: 268_402_689, failOn: "error" } as const;

function resolveModuleDir(): string {
  // ESM dev runtime: import.meta.url points at this source file.
  // CJS production bundle (esbuild --format=cjs): import.meta is rewritten to
  // an empty object, so url is undefined — fall back to __dirname, which CJS defines.
  const metaUrl: string | undefined = import.meta.url;
  if (metaUrl) return path.dirname(fileURLToPath(metaUrl));
  return __dirname;
}

function resolveFontsDir(): string {
  const moduleDir = resolveModuleDir();
  const candidates = [
    // ESM dev runtime: src/services -> src/assets/fonts
    path.join(moduleDir, "..", "assets", "fonts"),
    // CJS production bundle: dist/index.cjs -> dist/assets/fonts
    path.join(moduleDir, "assets", "fonts"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    `Designed-graphic fonts directory not found. Looked in: ${candidates.join(", ")}. ` +
      "Ensure font assets are shipped alongside the build (see build.ts copy step).",
  );
}

let fontsDir: string | null = null;

function getFontsDir(): string {
  if (!fontsDir) fontsDir = resolveFontsDir();
  return fontsDir;
}

const FONT_FILES: Record<DesignFont, string> = {
  anton: "Anton-Regular.ttf",
  archivo: "ArchivoBlack-Regular.ttf",
  barlow: "BarlowCondensed-Bold.ttf",
};

const fontCache = new Map<DesignFont, OTFont>();

export function loadDesignFont(font: DesignFont): OTFont {
  const cached = fontCache.get(font);
  if (cached) return cached;
  const file = path.join(getFontsDir(), FONT_FILES[font]);
  const buffer = fs.readFileSync(file);
  const parsed = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  fontCache.set(font, parsed);
  return parsed;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

interface LinePath {
  d: string;
  width: number;
  ascent: number;
  descent: number;
}

function lineToPath(font: OTFont, text: string, fontSize: number): LinePath {
  const scale = fontSize / font.unitsPerEm;
  const p = font.getPath(text, 0, 0, fontSize, { kerning: true });
  const advance = font.getAdvanceWidth(text, fontSize, { kerning: true });
  return {
    d: p.toPathData(2),
    width: advance,
    ascent: font.ascender * scale,
    descent: Math.abs(font.descender * scale),
  };
}

// Fit headline lines into a max width: find the largest font size (per block,
// shared across lines so the stack looks intentional) where the widest line fits.
export function fitHeadlineBlock(
  font: OTFont,
  lines: string[],
  maxWidth: number,
  maxFontSize: number,
  minFontSize: number,
): { fontSize: number; lines: LinePath[] } {
  let size = maxFontSize;
  for (; size >= minFontSize; size -= Math.max(2, Math.round(maxFontSize * 0.04))) {
    const widest = Math.max(...lines.map((l) => font.getAdvanceWidth(l, size, { kerning: true })));
    if (widest <= maxWidth) break;
  }
  size = Math.max(size, minFontSize);
  return { fontSize: size, lines: lines.map((l) => lineToPath(font, l, size)) };
}

export interface DesignedCompositeInput {
  spec: DesignSpec;
  subjectCutout: { buffer: Buffer; width: number; height: number } | null;
  logoBuffer: Buffer | null;
  width: number;
  height: number;
}

// Build the panels layer as one SVG (rotations included).
function panelsSvg(spec: DesignSpec, width: number, height: number): string {
  const rects = spec.panels
    .map((p) => {
      const x = p.x * width, y = p.y * height, w = p.w * width, h = p.h * height;
      const cx = x + w / 2, cy = y + h / 2;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.color}" fill-opacity="${p.opacity}" transform="rotate(${p.rotationDeg} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`;
    })
    .join("");
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

// Typography layer: headline block (+ optional subline) rendered as filled SVG paths.
function typographySvg(spec: DesignSpec, width: number, height: number): string {
  const font = loadDesignFont(spec.headline.font);
  const pad = Math.round(width * 0.06);
  const maxWidth = width - pad * 2;
  const maxFont = Math.round(height * 0.22 * spec.headline.scale);
  const minFont = Math.round(height * 0.05);
  const { fontSize, lines } = fitHeadlineBlock(font, spec.headline.lines, maxWidth, maxFont, minFont);
  const lineGap = Math.round(fontSize * 0.06);
  const lineHeight = fontSize + lineGap;
  const blockHeight = lines.length * lineHeight;

  let blockTop: number;
  switch (spec.headline.position) {
    case "top": blockTop = pad + fontSize; break;
    case "middle": blockTop = (height - blockHeight) / 2 + fontSize; break;
    default: blockTop = height - pad - blockHeight + fontSize; break;
  }

  const groups: string[] = [];
  lines.forEach((line, i) => {
    let x: number;
    switch (spec.headline.align) {
      case "center": x = (width - line.width) / 2; break;
      case "right": x = width - pad - line.width; break;
      default: x = pad; break;
    }
    const y = blockTop + i * lineHeight;
    const fill = i === spec.headline.accentWordIndex ? spec.accentColor : spec.headline.color;
    groups.push(`<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><path d="${line.d}" fill="${fill}"/></g>`);
  });

  let sublineMarkup = "";
  if (spec.subline) {
    const subFont = loadDesignFont("barlow");
    const subSize = Math.max(Math.round(fontSize * 0.22), Math.round(height * 0.022));
    const sub = lineToPath(subFont, spec.subline.text.toUpperCase(), subSize);
    let sx: number;
    switch (spec.headline.align) {
      case "center": sx = (width - sub.width) / 2; break;
      case "right": sx = width - pad - sub.width; break;
      default: sx = pad; break;
    }
    // Above the block when the headline sits at the bottom; below it otherwise.
    const sy = spec.headline.position === "bottom"
      ? blockTop - fontSize - Math.round(subSize * 1.2)
      : blockTop + (lines.length - 1) * lineHeight + Math.round(subSize * 2.2);
    const clampedSy = Math.min(Math.max(sy, subSize + 4), height - 4);
    sublineMarkup = `<g transform="translate(${sx.toFixed(1)} ${clampedSy.toFixed(1)})"><path d="${sub.d}" fill="${spec.subline.color}"/></g>`;
  }

  const rot = spec.headline.rotationDeg
    ? ` transform="rotate(${spec.headline.rotationDeg} ${width / 2} ${height / 2})"`
    : "";
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><g${rot}>${groups.join("")}${sublineMarkup}</g></svg>`;
}

function dataStripSvg(spec: DesignSpec, width: number, height: number): string | null {
  if (!spec.dataStrip) return null;
  const strip = spec.dataStrip;
  const stripH = Math.round(height * 0.055);
  const y = strip.position === "top" ? 0 : height - stripH;
  const font = loadDesignFont("barlow");
  const size = Math.round(stripH * 0.52);
  const line = lineToPath(font, strip.text.toUpperCase(), size);
  const tx = (width - line.width) / 2;
  const ty = y + stripH / 2 + size * 0.36;
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="${y}" width="${width}" height="${stripH}" fill="${strip.background}"/>` +
    `<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)})"><path d="${line.d}" fill="${strip.color}"/></g></svg>`;
}

// Texture pass: film grain (feTurbulence) or halftone dot pattern, composited
// as a soft-light-ish overlay at the given intensity.
function textureSvg(spec: DesignSpec, width: number, height: number): string | null {
  const t = spec.texture;
  if (t.type === "none" || t.intensity <= 0.01) return null;
  if (t.type === "grain") {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>` +
      `<feColorMatrix type="matrix" values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 ${(t.intensity * 0.5).toFixed(3)} 0"/></filter>` +
      `<rect width="${width}" height="${height}" filter="url(#g)"/></svg>`;
  }
  // Halftone: subtle dot grid, denser toward the bottom via two opacities.
  const dot = Math.max(4, Math.round(width / 160));
  const cell = dot * 3;
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><pattern id="ht" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">` +
    `<circle cx="${cell / 2}" cy="${cell / 2}" r="${dot / 2}" fill="#000000"/></pattern></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#ht)" fill-opacity="${(t.intensity * 0.28).toFixed(3)}"/></svg>`;
}

// Optional duotone treatment on the subject cutout (maps luminance dark→light
// between the two colors while preserving alpha).
export async function applyDuotone(cutout: Buffer, darkHex: string, lightHex: string): Promise<Buffer> {
  const parse = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [dr, dg, db] = parse(darkHex);
  const [lr, lg, lb] = parse(lightHex);
  const { data, info } = await sharp(cutout, SHARP_LIMITS).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    data[i] = Math.round(dr + (lr - dr) * lum);
    data[i + 1] = Math.round(dg + (lg - dg) * lum);
    data[i + 2] = Math.round(db + (lb - db) * lum);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

export async function compositeDesignedGraphic(input: DesignedCompositeInput): Promise<Buffer> {
  const { spec, width, height } = input;

  const layers: sharp.OverlayOptions[] = [];

  // Panels
  if (spec.panels.length > 0) {
    layers.push({ input: Buffer.from(panelsSvg(spec, width, height)) });
  }

  // Subject cutout
  if (input.subjectCutout) {
    let subjectBuf = input.subjectCutout.buffer;
    if (spec.subject.treatment === "duotone" && spec.subject.duotoneDark && spec.subject.duotoneLight) {
      try {
        subjectBuf = await applyDuotone(subjectBuf, spec.subject.duotoneDark, spec.subject.duotoneLight);
      } catch (err) {
        console.warn("Duotone treatment failed, using untreated cutout:", err instanceof Error ? err.message : err);
      }
    }
    const targetH = Math.round(height * spec.subject.scale);
    const resized = await sharp(subjectBuf, SHARP_LIMITS)
      .resize({ height: targetH, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const sw = meta.width || targetH;
    const sh = meta.height || targetH;
    let left: number;
    switch (spec.subject.placement) {
      case "left": left = Math.round(width * 0.02); break;
      case "right": left = width - sw - Math.round(width * 0.02); break;
      default: left = Math.round((width - sw) / 2); break;
    }
    // Anchor to the bottom of the canvas (posters ground the subject).
    const top = height - sh;
    // Clamp: sharp requires the overlay to intersect; crop if oversized.
    if (sw > width || sh > height || left < 0 || top < 0) {
      const cropLeft = Math.max(0, -left);
      const cropTop = Math.max(0, -top);
      const cropW = Math.min(sw - cropLeft, width - Math.max(0, left));
      const cropH = Math.min(sh - cropTop, height - Math.max(0, top));
      if (cropW > 0 && cropH > 0) {
        const cropped = await sharp(resized).extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).png().toBuffer();
        layers.push({ input: cropped, left: Math.max(0, left), top: Math.max(0, top) });
      }
    } else {
      layers.push({ input: resized, left, top });
    }
  }

  // Typography
  layers.push({ input: Buffer.from(typographySvg(spec, width, height)) });

  // Logo (bottom-right by convention, small, above texture)
  if (input.logoBuffer) {
    try {
      const maxLogoH = Math.round(height * 0.07);
      const logo = await sharp(input.logoBuffer, SHARP_LIMITS)
        .resize({ height: maxLogoH, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const lm = await sharp(logo).metadata();
      const margin = Math.round(width * 0.03);
      const stripPad = spec.dataStrip?.position === "bottom" ? Math.round(height * 0.055) : 0;
      layers.push({
        input: logo,
        left: width - (lm.width || maxLogoH) - margin,
        top: height - (lm.height || maxLogoH) - margin - stripPad,
      });
    } catch (err) {
      console.warn("Logo layer failed in designed composite:", err instanceof Error ? err.message : err);
    }
  }

  // Data strip
  const strip = dataStripSvg(spec, width, height);
  if (strip) layers.push({ input: Buffer.from(strip) });

  // Texture pass
  const texture = textureSvg(spec, width, height);
  if (texture) layers.push({ input: Buffer.from(texture), blend: "overlay" });

  const [r, g, b] = [spec.canvasColor.slice(1, 3), spec.canvasColor.slice(3, 5), spec.canvasColor.slice(5, 7)]
    .map((h) => parseInt(h, 16));

  return sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } },
    ...SHARP_LIMITS,
  })
    .composite(layers)
    .png()
    .toBuffer();
}

export { escapeXml };

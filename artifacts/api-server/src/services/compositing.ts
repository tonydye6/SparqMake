import sharp from "sharp";

const SHARP_LIMITS = { limitInputPixels: 268_402_689, failOn: "error" } as const;

export interface LayoutSpec {
  headline_zone?: {
    position?: string;
    alignment?: string;
    max_width_percent?: number;
    padding_px?: number;
    font_size_px?: number;
    color?: string;
    max_lines?: number;
  };
  logo_placement?: {
    position?: string;
    offset_px?: number;
    max_height_px?: number;
    opacity?: number;
  };
  gradient_overlay?: {
    type?: string;
    direction?: string;
    color?: string;
    start_opacity?: number;
    end_opacity?: number;
    height_percent?: number;
  };
  aspect_ratio_overrides?: Record<string, Partial<LayoutSpec>>;
}

// Normalized subject bounding box (mirrors focal-point.ts SubjectBox) — kept
// structural here to avoid a service-to-service type dependency.
export interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Brand palette guidance for the design-aware overlay treatment.
export interface BrandColorGuidance {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
}

interface CompositingInput {
  rawImageBuffer: Buffer;
  layoutSpec: LayoutSpec | null;
  headlineText: string | null;
  logoBuffer: Buffer | null;
  width: number;
  height: number;
  fontFamily?: string;
  // Brand palette: drives the overlay's glow/accent so the fallback still
  // reads on-brand instead of default-looking.
  brandColors?: BrandColorGuidance | null;
  // N1 fan-out: normalized (0..1) subject focal point. When set, the source is
  // reframed by cropping around this point (keeping the subject in frame) before
  // resizing; when null, falls back to the legacy centered cover-crop.
  focalPoint?: { x: number; y: number } | null;
  // Normalized subject bounding box. When present, the reframe crop window is
  // shifted (minimally, away from the focal-centered position) so the whole
  // subject stays in frame whenever the window is big enough to contain it.
  subjectBox?: NormalizedBox | null;
  // Aspect-ratio key (e.g. "9:16") used to look up layout_spec.aspect_ratio_overrides.
  // Defaults to `${width}:${height}` when omitted.
  aspectRatio?: string;
}

const DEFAULT_LAYOUT: LayoutSpec = {
  headline_zone: {
    position: "lower_third",
    alignment: "left",
    max_width_percent: 80,
    padding_px: 24,
    font_size_px: 48,
    color: "#FFFFFF",
    max_lines: 2,
  },
  gradient_overlay: {
    type: "linear",
    direction: "bottom_to_top",
    color: "#000000",
    start_opacity: 0.7,
    end_opacity: 0.0,
    height_percent: 40,
  },
};

// Resolve the effective layout for a given aspect ratio, applying any per-ratio
// override from layout_spec.aspect_ratio_overrides on top of the base (the
// nested zones are merged one level deep so a partial override is additive).
function resolveLayout(layoutSpec: LayoutSpec | null, aspectRatio: string): LayoutSpec {
  const base = layoutSpec ?? DEFAULT_LAYOUT;
  const override = base.aspect_ratio_overrides?.[aspectRatio];
  if (!override) return base;
  return {
    ...base,
    ...override,
    headline_zone: { ...base.headline_zone, ...override.headline_zone },
    logo_placement: { ...base.logo_placement, ...override.logo_placement },
    gradient_overlay: { ...base.gradient_overlay, ...override.gradient_overlay },
  };
}

function createGradientSvg(width: number, height: number, gradient: LayoutSpec["gradient_overlay"]): Buffer {
  if (!gradient) return Buffer.from("");

  const gradHeight = Math.round(height * (gradient.height_percent || 40) / 100);
  const color = gradient.color || "#000000";
  const startOpacity = gradient.start_opacity || 0.7;
  const endOpacity = gradient.end_opacity || 0.0;

  const isBottomToTop = gradient.direction !== "top_to_bottom";
  const y1 = isBottomToTop ? height : 0;
  const y2 = isBottomToTop ? height - gradHeight : gradHeight;

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="grad" x1="0" y1="${y1}" x2="0" y2="${y2}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="${color}" stop-opacity="${startOpacity}"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="${endOpacity}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#grad)"/>
  </svg>`;

  return Buffer.from(svg);
}

// --- Design-aware text fitting -------------------------------------------
// The overlay must never truncate: text is wrapped, then the font size is
// shrunk until every line fits the zone's max width AND the block fits the
// zone's vertical budget. Widths are estimated with a per-character factor
// (bold display type averages ~0.56em per char), with a safety margin.

const CHAR_WIDTH_EM = 0.56;

function estimateLineWidth(line: string, fontSize: number): number {
  return line.length * fontSize * CHAR_WIDTH_EM;
}

function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimateLineWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Pure: pick the largest font size (<= base, >= floor) at which the wrapped
// text fits maxWidth per line, uses at most maxLines when possible, and the
// block fits maxBlockHeight. Never drops words — if even the floor overflows
// maxLines, extra lines are kept and the size shrinks until the block fits
// vertically. Exported for tests.
export function fitHeadline(
  text: string,
  baseFontSize: number,
  maxWidth: number,
  maxLines: number,
  maxBlockHeight: number,
): { fontSize: number; lines: string[] } {
  const floor = Math.max(16, Math.round(baseFontSize * 0.4));
  let best: { fontSize: number; lines: string[] } | null = null;

  for (let size = baseFontSize; size >= floor; size = Math.max(floor, size - Math.max(2, Math.round(size * 0.08)))) {
    const lines = wrapText(text, size, maxWidth);
    const widest = Math.max(...lines.map(l => estimateLineWidth(l, size)), 0);
    const blockH = lines.length * size * 1.15;
    const fits = widest <= maxWidth && blockH <= maxBlockHeight;
    if (fits && lines.length <= maxLines) {
      return { fontSize: size, lines };
    }
    if (fits && !best) best = { fontSize: size, lines };
    if (size === floor) break;
  }
  if (best) return best;
  // Floor still overflows: return the floor wrap anyway (never truncate).
  return { fontSize: floor, lines: wrapText(text, floor, maxWidth) };
}

// Mean luminance (0..1) of a horizontal band of the image, used to decide the
// text/scrim treatment. Best-effort — defaults to "dark" (light text) on error.
async function bandLuminance(imageBuffer: Buffer, position: string | undefined): Promise<number> {
  try {
    const img = sharp(imageBuffer, SHARP_LIMITS);
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return 0.25;
    const bandH = Math.max(1, Math.round(h / 3));
    const top = position === "upper_third" ? 0 : position === "center" ? Math.round((h - bandH) / 2) : h - bandH;
    const stats = await sharp(imageBuffer, SHARP_LIMITS)
      .extract({ left: 0, top, width: w, height: bandH })
      .stats();
    const [r, g, b] = stats.channels;
    if (!r || !g || !b) return 0.25;
    return (0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean) / 255;
  } catch {
    return 0.25;
  }
}

interface TextTreatment {
  color: string;
  glowColor: string;
  scrimColor: string;
  scrimOpacity: number;
}

// Derive the overlay treatment from the scene + brand: light text with a dark
// scrim over dark/midtone bands, dark text over very bright bands; the glow
// picks up the brand accent so the fallback still reads intentional.
function deriveTreatment(luminance: number, zoneColor: string | undefined, brandColors?: BrandColorGuidance | null): TextTreatment {
  const accent = brandColors?.accent || brandColors?.primary || null;
  if (luminance > 0.72) {
    return {
      color: "#111318",
      glowColor: "#FFFFFF",
      scrimColor: "#FFFFFF",
      scrimOpacity: 0.35,
    };
  }
  return {
    color: zoneColor || "#FFFFFF",
    glowColor: accent || "#000000",
    scrimColor: "#000000",
    scrimOpacity: luminance > 0.45 ? 0.45 : 0.25,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function createTextSvg(
  text: string,
  width: number,
  height: number,
  zone: LayoutSpec["headline_zone"],
  fontFamily: string = "sans-serif",
  treatment?: TextTreatment,
): Buffer {
  if (!zone || !text) return Buffer.from("");

  // Layout specs are authored against a ~1080px canvas; scale the base size to
  // this variant's dimensions so small formats don't get oversized type.
  const scale = Math.min(width, height) / 1080;
  const baseFontSize = Math.max(18, Math.round((zone.font_size_px || 48) * Math.max(0.5, Math.min(scale, 1.6))));
  const padding = Math.max(zone.padding_px || 24, Math.round(Math.min(width, height) * 0.05));
  const maxWidthPct = zone.max_width_percent || 80;
  const maxWidth = Math.min(Math.round(width * maxWidthPct / 100), width - padding * 2);
  const alignment = zone.alignment || "left";
  const maxLines = zone.max_lines || 2;

  // Vertical budget: the zone's third of the canvas, minus padding.
  const maxBlockHeight = Math.max(baseFontSize, Math.round(height / 3) - padding);
  const { fontSize, lines: displayLines } = fitHeadline(text, baseFontSize, maxWidth, maxLines, maxBlockHeight);

  const t = treatment ?? deriveTreatment(0.25, zone.color);

  const lineHeight = fontSize * 1.15;
  const totalTextHeight = displayLines.length * lineHeight;

  let yStart: number;
  if (zone.position === "upper_third") {
    yStart = padding + fontSize;
  } else if (zone.position === "center") {
    yStart = (height - totalTextHeight) / 2 + fontSize;
  } else {
    yStart = height - padding - totalTextHeight + fontSize;
  }
  // Clamp so the block can never bleed off the top/bottom edge.
  yStart = Math.min(Math.max(yStart, padding + fontSize), height - padding - totalTextHeight + fontSize);

  let textAnchor = "start";
  let xPos = padding;
  if (alignment === "center") {
    textAnchor = "middle";
    xPos = width / 2;
  } else if (alignment === "right") {
    textAnchor = "end";
    xPos = width - padding;
  }

  // Soft scrim panel behind the text block keeps legibility without the
  // "default drop shadow on a photo" look.
  const scrimPad = Math.round(fontSize * 0.6);
  const widestLine = Math.max(...displayLines.map(l => estimateLineWidth(l, fontSize)), 0);
  let scrimX = xPos - scrimPad;
  if (alignment === "center") scrimX = xPos - widestLine / 2 - scrimPad;
  else if (alignment === "right") scrimX = xPos - widestLine - scrimPad;
  const scrimY = yStart - fontSize - scrimPad * 0.6;
  const scrimW = widestLine + scrimPad * 2;
  const scrimH = totalTextHeight + scrimPad * 1.2;

  const textElements = displayLines.map((line, i) => {
    const y = yStart + i * lineHeight;
    const escaped = escapeXml(line);
    return `<text x="${xPos}" y="${y}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="800" letter-spacing="${(fontSize * 0.01).toFixed(1)}" fill="${t.color}" text-anchor="${textAnchor}" filter="url(#glow)">${escaped}</text>`;
  }).join("\n    ");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="${Math.max(1, Math.round(fontSize * 0.03))}" stdDeviation="${Math.max(2, Math.round(fontSize * 0.08))}" flood-color="${t.glowColor}" flood-opacity="0.55"/>
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.5"/>
      </filter>
      <linearGradient id="scrimfade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${t.scrimColor}" stop-opacity="0"/>
        <stop offset="35%" stop-color="${t.scrimColor}" stop-opacity="${t.scrimOpacity}"/>
        <stop offset="100%" stop-color="${t.scrimColor}" stop-opacity="${t.scrimOpacity}"/>
      </linearGradient>
    </defs>
    <rect x="${Math.round(scrimX)}" y="${Math.round(scrimY)}" width="${Math.round(scrimW)}" height="${Math.round(scrimH)}" rx="${Math.round(fontSize * 0.25)}" fill="url(#scrimfade)"/>
    ${textElements}
  </svg>`;

  return Buffer.from(svg);
}

export interface CompositingResult {
  buffer: Buffer;
  warnings: string[];
}

// Pure: pick a crop-window origin (1D). Start centered on the focal point,
// then shift the minimum needed so [boxLo, boxHi] is inside the window when
// the window is big enough to contain it; when it isn't, center on the box.
// All values in source pixels. Exported for tests.
export function chooseCropOrigin(
  focalCenter: number,
  cropSize: number,
  sourceSize: number,
  boxLo: number | null,
  boxHi: number | null,
): number {
  let origin = focalCenter - cropSize / 2;
  if (boxLo != null && boxHi != null) {
    const boxSize = boxHi - boxLo;
    if (boxSize <= cropSize) {
      if (boxLo < origin) origin = boxLo;
      if (boxHi > origin + cropSize) origin = boxHi - cropSize;
    } else {
      origin = (boxLo + boxHi) / 2 - cropSize / 2;
    }
  }
  return Math.min(Math.max(0, Math.round(origin)), Math.max(0, sourceSize - cropSize));
}

// Reframe the source to width×height. With a focal point, crop the largest
// target-aspect window centered on that point — shifted, when a subject box is
// known, so the whole subject stays in frame whenever it fits — clamped to the
// image bounds. Without a focal point, fall back to the legacy centered
// cover-crop. Deterministic — no model call.
async function reframe(
  rawImageBuffer: Buffer,
  width: number,
  height: number,
  focalPoint: { x: number; y: number } | null,
  warnings: string[],
  subjectBox?: NormalizedBox | null,
): Promise<sharp.Sharp> {
  if (!focalPoint) {
    return sharp(rawImageBuffer, SHARP_LIMITS).resize(width, height, { fit: "cover" });
  }
  try {
    const meta = await sharp(rawImageBuffer, SHARP_LIMITS).metadata();
    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    if (!rawW || !rawH) {
      return sharp(rawImageBuffer, SHARP_LIMITS).resize(width, height, { fit: "cover" });
    }

    const targetAspect = width / height;
    let cropW: number;
    let cropH: number;
    if (rawW / rawH > targetAspect) {
      cropH = rawH;
      cropW = Math.round(rawH * targetAspect);
    } else {
      cropW = rawW;
      cropH = Math.round(rawW / targetAspect);
    }
    cropW = Math.min(Math.max(1, cropW), rawW);
    cropH = Math.min(Math.max(1, cropH), rawH);

    // Ignore degenerate/full-frame boxes — they carry no placement signal.
    const box = subjectBox && (subjectBox.x1 - subjectBox.x0) > 0.01 && (subjectBox.y1 - subjectBox.y0) > 0.01 &&
      !(subjectBox.x0 <= 0.001 && subjectBox.y0 <= 0.001 && subjectBox.x1 >= 0.999 && subjectBox.y1 >= 0.999)
      ? subjectBox : null;

    const left = chooseCropOrigin(focalPoint.x * rawW, cropW, rawW, box ? box.x0 * rawW : null, box ? box.x1 * rawW : null);
    const top = chooseCropOrigin(focalPoint.y * rawH, cropH, rawH, box ? box.y0 * rawH : null, box ? box.y1 * rawH : null);

    return sharp(rawImageBuffer, SHARP_LIMITS)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(width, height);
  } catch (err) {
    warnings.push(`Focal reframe failed, using centered crop: ${err instanceof Error ? err.message : err}`);
    return sharp(rawImageBuffer, SHARP_LIMITS).resize(width, height, { fit: "cover" });
  }
}

export async function compositeImage(input: CompositingInput): Promise<CompositingResult> {
  const { rawImageBuffer, layoutSpec, headlineText, logoBuffer, width, height, fontFamily, brandColors, focalPoint, subjectBox, aspectRatio } = input;
  const warnings: string[] = [];

  const resolved = resolveLayout(layoutSpec, aspectRatio ?? `${width}:${height}`);

  let image = await reframe(rawImageBuffer, width, height, focalPoint ?? null, warnings, subjectBox ?? null);

  const overlays: sharp.OverlayOptions[] = [];

  if (resolved.gradient_overlay) {
    const gradientSvg = createGradientSvg(width, height, resolved.gradient_overlay);
    if (gradientSvg.length > 0) {
      overlays.push({ input: gradientSvg, top: 0, left: 0 });
    }
  }

  if (headlineText && resolved.headline_zone) {
    // Design-aware treatment: sample the zone band's luminance on the (already
    // reframed) base so the text/scrim adapts to the scene, not a default.
    let treatment: TextTreatment | undefined;
    try {
      const baseForSampling = await image.clone().png().toBuffer();
      const lum = await bandLuminance(baseForSampling, resolved.headline_zone.position);
      treatment = deriveTreatment(lum, resolved.headline_zone.color, brandColors);
    } catch {
      treatment = undefined;
    }
    const textSvg = createTextSvg(headlineText, width, height, resolved.headline_zone, fontFamily, treatment);
    if (textSvg.length > 0) {
      overlays.push({ input: textSvg, top: 0, left: 0 });
    }
  }

  if (logoBuffer && resolved.logo_placement) {
    const placement = resolved.logo_placement;
    const maxH = placement.max_height_px || 40;
    const offset = placement.offset_px || 24;

    try {
      const resizedLogo = await sharp(logoBuffer, SHARP_LIMITS)
        .resize({ height: maxH, withoutEnlargement: true })
        .toBuffer();

      const logoMeta = await sharp(resizedLogo, SHARP_LIMITS).metadata();
      const logoW = logoMeta.width || maxH;
      const logoH = logoMeta.height || maxH;

      let top = height - logoH - offset;
      let left = width - logoW - offset;

      if (placement.position === "top_left") { top = offset; left = offset; }
      else if (placement.position === "top_right") { top = offset; }
      else if (placement.position === "bottom_left") { left = offset; }

      overlays.push({ input: resizedLogo, top, left });
    } catch (err) {
      const msg = `Failed to process logo for compositing: ${err instanceof Error ? err.message : err}`;
      console.error(msg);
      warnings.push(msg);
    }
  }

  if (overlays.length > 0) {
    image = image.composite(overlays);
  }

  return { buffer: await image.png().toBuffer(), warnings };
}

export async function recompositeWithNewHeadline(
  rawImageBuffer: Buffer,
  layoutSpec: LayoutSpec | null,
  newHeadline: string,
  logoBuffer: Buffer | null,
  width: number,
  height: number,
): Promise<CompositingResult> {
  return compositeImage({
    rawImageBuffer,
    layoutSpec,
    headlineText: newHeadline,
    logoBuffer,
    width,
    height,
  });
}

// Width/height of an encoded image (0,0 if unreadable). Used for clip prediction.
export async function imageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buffer, SHARP_LIMITS).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// N1 fan-out: produce a reframed RAW (no overlay) cropped to width×height around
// the focal point. Used as the per-platform base image so downstream overlays
// (and instant headline recomposites) operate on the already-correct aspect.
export async function reframeImage(
  rawImageBuffer: Buffer,
  width: number,
  height: number,
  focalPoint: { x: number; y: number } | null,
  subjectBox?: NormalizedBox | null,
): Promise<Buffer> {
  const warnings: string[] = [];
  const img = await reframe(rawImageBuffer, width, height, focalPoint, warnings, subjectBox ?? null);
  return img.png().toBuffer();
}

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

interface CompositingInput {
  rawImageBuffer: Buffer;
  layoutSpec: LayoutSpec | null;
  headlineText: string | null;
  logoBuffer: Buffer | null;
  width: number;
  height: number;
  fontFamily?: string;
  // N1 fan-out: normalized (0..1) subject focal point. When set, the source is
  // reframed by cropping around this point (keeping the subject in frame) before
  // resizing; when null, falls back to the legacy centered cover-crop.
  focalPoint?: { x: number; y: number } | null;
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

function createTextSvg(
  text: string,
  width: number,
  height: number,
  zone: LayoutSpec["headline_zone"],
  fontFamily: string = "sans-serif",
): Buffer {
  if (!zone || !text) return Buffer.from("");

  const fontSize = zone.font_size_px || 48;
  const color = zone.color || "#FFFFFF";
  const padding = zone.padding_px || 24;
  const maxWidthPct = zone.max_width_percent || 80;
  const maxWidth = Math.round(width * maxWidthPct / 100);
  const alignment = zone.alignment || "left";

  const charsPerLine = Math.floor(maxWidth / (fontSize * 0.55));
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 > charsPerLine) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += (currentLine ? " " : "") + word;
    }
  }
  if (currentLine) lines.push(currentLine.trim());

  const maxLines = zone.max_lines || 2;
  const displayLines = lines.slice(0, maxLines);

  const lineHeight = fontSize * 1.2;
  const totalTextHeight = displayLines.length * lineHeight;

  let yStart: number;
  if (zone.position === "upper_third") {
    yStart = padding + fontSize;
  } else if (zone.position === "center") {
    yStart = (height - totalTextHeight) / 2 + fontSize;
  } else {
    yStart = height - padding - totalTextHeight + fontSize;
  }

  let textAnchor = "start";
  let xPos = padding;
  if (alignment === "center") {
    textAnchor = "middle";
    xPos = width / 2;
  } else if (alignment === "right") {
    textAnchor = "end";
    xPos = width - padding;
  }

  const escapedLines = displayLines.map(l =>
    l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );

  const textElements = escapedLines.map((line, i) => {
    const y = yStart + i * lineHeight;
    return `<text x="${xPos}" y="${y}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="800" fill="${color}" text-anchor="${textAnchor}" filter="url(#shadow)">${line}</text>`;
  }).join("\n    ");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.7"/>
      </filter>
    </defs>
    ${textElements}
  </svg>`;

  return Buffer.from(svg);
}

export interface CompositingResult {
  buffer: Buffer;
  warnings: string[];
}

// Reframe the source to width×height. With a focal point, crop the largest
// target-aspect window centered on that point (clamped to the image bounds) so
// the subject stays in frame; without one, fall back to the legacy centered
// cover-crop. Deterministic — no model call.
async function reframe(
  rawImageBuffer: Buffer,
  width: number,
  height: number,
  focalPoint: { x: number; y: number } | null,
  warnings: string[],
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

    let left = Math.round(focalPoint.x * rawW - cropW / 2);
    let top = Math.round(focalPoint.y * rawH - cropH / 2);
    left = Math.min(Math.max(0, left), rawW - cropW);
    top = Math.min(Math.max(0, top), rawH - cropH);

    return sharp(rawImageBuffer, SHARP_LIMITS)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(width, height);
  } catch (err) {
    warnings.push(`Focal reframe failed, using centered crop: ${err instanceof Error ? err.message : err}`);
    return sharp(rawImageBuffer, SHARP_LIMITS).resize(width, height, { fit: "cover" });
  }
}

export async function compositeImage(input: CompositingInput): Promise<CompositingResult> {
  const { rawImageBuffer, layoutSpec, headlineText, logoBuffer, width, height, fontFamily, focalPoint, aspectRatio } = input;
  const warnings: string[] = [];

  const resolved = resolveLayout(layoutSpec, aspectRatio ?? `${width}:${height}`);

  let image = await reframe(rawImageBuffer, width, height, focalPoint ?? null, warnings);

  const overlays: sharp.OverlayOptions[] = [];

  if (resolved.gradient_overlay) {
    const gradientSvg = createGradientSvg(width, height, resolved.gradient_overlay);
    if (gradientSvg.length > 0) {
      overlays.push({ input: gradientSvg, top: 0, left: 0 });
    }
  }

  if (headlineText && resolved.headline_zone) {
    const textSvg = createTextSvg(headlineText, width, height, resolved.headline_zone, fontFamily);
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
): Promise<Buffer> {
  const warnings: string[] = [];
  const img = await reframe(rawImageBuffer, width, height, focalPoint, warnings);
  return img.png().toBuffer();
}

import sharp from "sharp";
import { ai } from "@workspace/integrations-gemini-ai";
import { Modality } from "@google/genai";
import { AI_MODELS } from "../lib/ai-config.js";

// Subject cutout stage of the designed-graphic pipeline. The Gemini image
// model cannot emit alpha, so we ask it for the subject on a FLAT chroma-green
// backdrop and then chroma-key that backdrop away with a raw-pixel pass,
// producing an RGBA cutout the compositor can layer under/over typography.

const CHROMA_PROMPT_SUFFIX =
  "\n\nCRITICAL RENDERING REQUIREMENTS:\n" +
  "- ONE single subject only, full subject visible, dynamic and dramatic.\n" +
  "- The ENTIRE background must be a perfectly flat, uniform, pure chroma-key green (#00FF00). No gradients, no shadows on the background, no floor, no environment, no props touching the edges.\n" +
  "- Studio-quality lighting ON THE SUBJECT only. Crisp edges, no green rim light, no motion blur at the silhouette.\n" +
  "- Absolutely no text, letters, numbers, logos, or watermarks.";

const MAX_ATTEMPTS = 3;

export interface SubjectCutoutOptions {
  /** Vivid subject description from the design spec. */
  prompt: string;
  /** Reference images (subject likeness) to steer the render. */
  referenceImages?: Array<{ imageBuffer: Buffer; mimeType?: string }>;
}

export interface SubjectCutout {
  /** RGBA PNG with transparent background, trimmed to subject bounds. */
  buffer: Buffer;
  width: number;
  height: number;
}

async function requestChromaImage(opts: SubjectCutoutOptions): Promise<Buffer | null> {
  const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];
  for (const ref of (opts.referenceImages || []).slice(0, 3)) {
    parts.push({ inlineData: { data: ref.imageBuffer.toString("base64"), mimeType: ref.mimeType || "image/png" } });
  }
  parts.push({ text: `${opts.prompt}${CHROMA_PROMPT_SUFFIX}` });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120_000);
  let response;
  try {
    response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_IMAGE,
      contents: [{ role: "user", parts }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE], abortSignal: abortController.signal },
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const imagePart = response.candidates?.[0]?.content?.parts?.find(
    (p: { inlineData?: { data?: string } }) => p.inlineData?.data,
  ) as { inlineData?: { data?: string } } | undefined;
  return imagePart?.inlineData?.data ? Buffer.from(imagePart.inlineData.data, "base64") : null;
}

// Chroma-key removal on raw pixels: a pixel is "green screen" when green
// dominates both red and blue by a margin. Soft threshold band gives feathered
// edges; green spill on semi-transparent edge pixels is neutralized.
export async function chromaKeyGreen(input: Buffer): Promise<SubjectCutout> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = data;
  const channels = info.channels; // 4 after ensureAlpha
  for (let i = 0; i < px.length; i += channels) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    // Green dominance measure: how much greener than the other channels.
    const dominance = g - Math.max(r, b);
    if (dominance > 60 && g > 90) {
      px[i + 3] = 0; // hard key
    } else if (dominance > 25 && g > 70) {
      // Soft edge band: fade alpha and pull green spill toward the neutral of r/b.
      const t = (dominance - 25) / 35; // 0..1
      px[i + 3] = Math.round(px[i + 3] * (1 - t));
      const neutral = Math.round((r + b) / 2);
      px[i + 1] = Math.min(g, neutral + 10);
    } else if (dominance > 8) {
      // Spill suppression only (fully opaque pixel with a green cast at edge).
      const neutral = Math.round((r + b) / 2);
      px[i + 1] = Math.min(g, neutral + Math.round((g - neutral) * 0.5));
    }
  }

  const keyed = await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();

  // Trim fully transparent borders so the compositor scales the true subject bounds.
  const trimmed = await sharp(keyed).trim({ threshold: 10 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  return { buffer: trimmed, width: meta.width || info.width, height: meta.height || info.height };
}

// Sanity check that the key actually produced a usable cutout: enough of the
// frame must be transparent (background removed) AND enough must remain opaque
// (the subject survived).
export async function cutoutQuality(cutout: Buffer, originalWidth: number, originalHeight: number): Promise<{ ok: boolean; opaqueRatio: number }> {
  const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  const total = info.width * info.height;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] > 200) opaque++;
  }
  const opaqueRatio = total > 0 ? opaque / total : 0;
  const coverage = (info.width * info.height) / (originalWidth * originalHeight);
  // After trim, a good cutout is mostly-opaque subject occupying a real chunk
  // of the original frame. Reject near-empty or un-keyed (fully opaque, no trim) results.
  const ok = opaqueRatio > 0.25 && opaqueRatio < 0.995 && coverage > 0.05;
  return { ok, opaqueRatio };
}

export async function generateSubjectCutout(opts: SubjectCutoutOptions): Promise<SubjectCutout> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await requestChromaImage(opts);
      if (!raw) {
        lastError = new Error("Image model returned no image data for subject cutout");
        continue;
      }
      const meta = await sharp(raw).metadata();
      const cutout = await chromaKeyGreen(raw);
      const quality = await cutoutQuality(cutout.buffer, meta.width || cutout.width, meta.height || cutout.height);
      if (quality.ok) return cutout;
      lastError = new Error(`Cutout quality check failed (opaque ratio ${quality.opaqueRatio.toFixed(2)})`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 750 * attempt));
    }
  }
  throw lastError || new Error("Subject cutout generation failed");
}

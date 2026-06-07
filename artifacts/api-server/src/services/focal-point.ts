import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS } from "../lib/ai-config.js";

export interface FocalPoint {
  x: number; // normalized 0..1, left → right
  y: number; // normalized 0..1, top → bottom
}

// Normalized (0..1) bounding box of the primary subject.
export interface SubjectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SubjectDetection {
  focal: FocalPoint;
  box: SubjectBox;
}

export const CENTER_FOCAL: FocalPoint = { x: 0.5, y: 0.5 };
export const FULL_BOX: SubjectBox = { x0: 0, y0: 0, x1: 1, y1: 1 };

// Locate the primary subject in an image: its bounding box (drives clip
// prediction when reframing to other aspect ratios) and its focal center
// (drives the crop). All normalized 0..1. Falls back to a centered point /
// full-frame box if vision is unavailable or the response can't be parsed — the
// caller still gets a usable (centered, no-clip) result rather than an error.
export async function detectSubject(imageBuffer: Buffer, mimeType = "image/png"): Promise<SubjectDetection> {
  const prompt = `You are analyzing a social media image to locate its primary subject (a character, mascot, player, product, or person).

Return the subject's bounding box and focal center, all normalized between 0 and 1 (x = left→right, y = top→bottom). If there are multiple subjects, pick the most prominent. If there is no clear subject, return the main area of visual interest.

Return ONLY valid JSON, no markdown:
{"box": {"x0": number, "y0": number, "x1": number, "y1": number}, "focal": {"x": number, "y": number}}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120_000);
  try {
    let response;
    try {
      response = await ai.models.generateContent({
        model: AI_MODELS.GEMINI_FLASH_TEXT,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { data: imageBuffer.toString("base64"), mimeType } },
            ],
          },
        ],
        config: {
          abortSignal: abortController.signal,
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = response.candidates?.[0]?.content?.parts
      ?.filter((part: { text?: string }) => part.text)
      .map((part: { text?: string }) => part.text)
      .join("") || "";

    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const box = normalizeBox(parsed.box);

    // Focal defaults to the box center when the model omits it.
    let fx = Number(parsed.focal?.x);
    let fy = Number(parsed.focal?.y);
    if (!Number.isFinite(fx)) fx = (box.x0 + box.x1) / 2;
    if (!Number.isFinite(fy)) fy = (box.y0 + box.y1) / 2;

    return { focal: { x: clamp01(fx), y: clamp01(fy) }, box };
  } catch (err) {
    console.error("Subject detection failed, using center/full-frame:", err instanceof Error ? err.message : err);
    return { focal: CENTER_FOCAL, box: FULL_BOX };
  }
}

// Pure: would reframing to `targetAspect` around `focal` clip the subject `box`?
// `sourceAspect` = source image width/height. All coordinates normalized 0..1.
// Mirrors the crop window computed in compositing's reframe(): a cover-style
// window of the target aspect, centered on the focal point and clamped to bounds.
export function predictClip(
  box: SubjectBox,
  focal: FocalPoint,
  sourceAspect: number,
  targetAspect: number,
): boolean {
  let cropWNorm: number;
  let cropHNorm: number;
  if (sourceAspect > targetAspect) {
    cropWNorm = targetAspect / sourceAspect;
    cropHNorm = 1;
  } else {
    cropWNorm = 1;
    cropHNorm = sourceAspect / targetAspect;
  }
  const left = Math.min(Math.max(0, focal.x - cropWNorm / 2), 1 - cropWNorm);
  const top = Math.min(Math.max(0, focal.y - cropHNorm / 2), 1 - cropHNorm);
  const right = left + cropWNorm;
  const bottom = top + cropHNorm;
  const eps = 0.005; // tolerate hairline rounding
  return box.x0 < left - eps || box.x1 > right + eps || box.y0 < top - eps || box.y1 > bottom + eps;
}

function normalizeBox(b: unknown): SubjectBox {
  const o = (b ?? {}) as Record<string, unknown>;
  const raw = [Number(o.x0), Number(o.y0), Number(o.x1), Number(o.y1)];
  if (!raw.every((n) => Number.isFinite(n))) return FULL_BOX;
  const [x0, y0, x1, y1] = raw.map((n) => Math.min(1, Math.max(0, n)));
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

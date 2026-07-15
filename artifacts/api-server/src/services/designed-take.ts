import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS } from "../lib/ai-config.js";
import { extractJSON } from "../lib/extract-json.js";
import { generateDesignSpec, type DesignSpec, type DesignSpecInput } from "./design-spec.js";
import { generateSubjectCutout, type SubjectCutout } from "./subject-cutout.js";
import { compositeDesignedGraphic } from "./designed-compositor.js";

// Orchestrator for the "designed graphic" render mode: design-spec LLM stage →
// subject cutout (chroma-keyed) → deterministic multi-layer compositor →
// lightweight vision quality gate with ONE corrective re-composite (free — it
// only re-runs the compositor with an adjusted spec, no extra image calls).

export interface DesignedTakeOptions {
  briefText: string;
  headlineText?: string | null;
  brandName?: string;
  brandColors: DesignSpecInput["brandColors"];
  persona?: DesignSpecInput["persona"];
  /** Subject-likeness reference images (steer the cutout render). */
  subjectReferences?: Array<{ imageBuffer: Buffer; mimeType?: string }>;
  logoBuffer: Buffer | null;
  width: number;
  height: number;
  aspectRatio: string;
}

export interface DesignedTakeResult {
  buffer: Buffer;
  spec: DesignSpec;
  usedFallbackSpec: boolean;
  cutoutFailed: boolean;
  qualityRetried: boolean;
}

interface QualityVerdict {
  ok: boolean;
  headlineLegible: boolean;
  subjectWellPlaced: boolean;
  issue?: string;
}

const QUALITY_PROMPT = `You are a strict art director reviewing a composited sports/social graphic. Answer ONLY as JSON:
{"ok": boolean, "headlineLegible": boolean, "subjectWellPlaced": boolean, "issue": "one short sentence if not ok"}
- headlineLegible: is the display headline clearly readable against what's behind it?
- subjectWellPlaced: is the subject (if any) well framed, not awkwardly cropped, not fully hiding the headline?
- ok: true only if both are true.`;

async function checkQuality(imageBuffer: Buffer): Promise<QualityVerdict | null> {
  try {
    const response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_TEXT,
      contents: [{
        role: "user",
        parts: [
          { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/png" } },
          { text: QUALITY_PROMPT },
        ],
      }],
    });
    const text = response.candidates?.[0]?.content?.parts
      ?.filter((p: { text?: string }) => p.text).map((p: { text?: string }) => p.text).join("") || "";
    const parsed = extractJSON<Record<string, unknown>>(text);
    return {
      ok: parsed.ok === true,
      headlineLegible: parsed.headlineLegible !== false,
      subjectWellPlaced: parsed.subjectWellPlaced !== false,
      issue: typeof parsed.issue === "string" ? parsed.issue : undefined,
    };
  } catch (err) {
    console.warn("Designed-take quality check failed (skipping gate):", err instanceof Error ? err.message : err);
    return null;
  }
}

// Deterministic corrective adjustments driven by the verdict: move/re-color
// type for legibility, shrink/recenter the subject for placement.
function correctSpec(spec: DesignSpec, verdict: QualityVerdict): DesignSpec {
  const next: DesignSpec = structuredClone(spec);
  if (!verdict.headlineLegible) {
    // Flip the headline to the opposite band and back it with a solid panel.
    next.headline.position = spec.headline.position === "bottom" ? "top" : "bottom";
    next.headline.color = luminance(next.canvasColor) > 0.5 ? "#111111" : "#f5f5f0";
    const bandY = next.headline.position === "top" ? 0 : 0.62;
    next.panels = [
      ...next.panels.slice(0, 3),
      { x: 0, y: bandY, w: 1, h: 0.38, color: next.canvasColor, opacity: 0.85, rotationDeg: 0 },
    ];
  }
  if (!verdict.subjectWellPlaced) {
    next.subject.scale = Math.max(0.6, next.subject.scale - 0.2);
    next.subject.placement = next.headline.align === "left" ? "right" : "left";
  }
  return next;
}

function luminance(hexColor: string): number {
  const r = parseInt(hexColor.slice(1, 3), 16) / 255;
  const g = parseInt(hexColor.slice(3, 5), 16) / 255;
  const b = parseInt(hexColor.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Step 1: the billable work (design-spec LLM call + one subject-cutout image
// call). Prepared once, then rendered at any number of aspect ratios for free.
export interface PreparedDesign {
  spec: DesignSpec;
  cutout: SubjectCutout | null;
  usedFallbackSpec: boolean;
  cutoutFailed: boolean;
}

export async function prepareDesignedTake(
  opts: Omit<DesignedTakeOptions, "logoBuffer" | "width" | "height">,
): Promise<PreparedDesign> {
  const { spec, usedFallback } = await generateDesignSpec({
    briefText: opts.briefText,
    headlineText: opts.headlineText,
    brandName: opts.brandName,
    brandColors: opts.brandColors,
    persona: opts.persona,
    aspectRatio: opts.aspectRatio,
  });

  let cutout: SubjectCutout | null = null;
  let cutoutFailed = false;
  try {
    cutout = await generateSubjectCutout({
      prompt: spec.subject.prompt,
      referenceImages: opts.subjectReferences,
    });
  } catch (err) {
    // The graphic still works as pure typographic design — degrade gracefully.
    cutoutFailed = true;
    console.warn("Subject cutout failed; rendering type-only designed graphic:", err instanceof Error ? err.message : err);
  }

  return { spec, cutout, usedFallbackSpec: usedFallback, cutoutFailed };
}

// Step 2: deterministic render + quality gate at a specific canvas size.
export async function renderDesignedGraphic(
  prepared: PreparedDesign,
  opts: { logoBuffer: Buffer | null; width: number; height: number; headlineText?: string | null },
): Promise<DesignedTakeResult> {
  // A per-render headline override (e.g. Claude's platform headline) replaces
  // the spec's lines while keeping the spec's typography treatment.
  const spec: DesignSpec = opts.headlineText
    ? { ...prepared.spec, headline: { ...prepared.spec.headline, lines: splitHeadline(opts.headlineText) } }
    : prepared.spec;
  const { cutout, usedFallbackSpec, cutoutFailed } = prepared;

  let buffer = await compositeDesignedGraphic({
    spec,
    subjectCutout: cutout,
    logoBuffer: opts.logoBuffer,
    width: opts.width,
    height: opts.height,
  });

  let qualityRetried = false;
  const verdict = await checkQuality(buffer);
  if (verdict && !verdict.ok) {
    qualityRetried = true;
    const corrected = correctSpec(spec, verdict);
    try {
      buffer = await compositeDesignedGraphic({
        spec: corrected,
        subjectCutout: cutout,
        logoBuffer: opts.logoBuffer,
        width: opts.width,
        height: opts.height,
      });
      return { buffer, spec: corrected, usedFallbackSpec, cutoutFailed, qualityRetried };
    } catch (err) {
      console.warn("Corrective re-composite failed; keeping first render:", err instanceof Error ? err.message : err);
    }
  }

  return { buffer, spec, usedFallbackSpec, cutoutFailed, qualityRetried };
}

// Split a free-form headline into 1-3 short display lines (<= 24 chars each,
// aiming for ~14 to keep the type big).
export function splitHeadline(text: string): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > 14 && current) {
      lines.push(current);
      current = w;
      if (lines.length === 2) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < 3) lines.push(current);
  return (lines.length > 0 ? lines : ["GAME DAY"]).map((l) => l.slice(0, 24));
}

// One-shot convenience: prepare + render at a single size.
export async function generateDesignedTake(opts: DesignedTakeOptions): Promise<DesignedTakeResult> {
  const prepared = await prepareDesignedTake(opts);
  return renderDesignedGraphic(prepared, {
    logoBuffer: opts.logoBuffer,
    width: opts.width,
    height: opts.height,
  });
}

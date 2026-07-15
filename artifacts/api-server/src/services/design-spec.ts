import { z } from "zod/v4";
import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS } from "../lib/ai-config.js";
import { extractJSON } from "../lib/extract-json.js";

// Design-spec stage of the "designed graphic" pipeline: an LLM acts as the
// persona's art director and emits a STRUCTURED layout plan (colors, panels,
// display typography, subject placement, texture treatment). The compositor
// then renders that plan deterministically — real composited typography and
// panels, not AI-drawn text. Every numeric field is clamped after parsing so a
// creative-but-sloppy model response can never break the render.

export const DESIGN_FONTS = ["anton", "archivo", "barlow"] as const;
export type DesignFont = (typeof DESIGN_FONTS)[number];

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((v) => v.toLowerCase());

const clamp = (min: number, max: number) => z.number().transform((v) => Math.min(max, Math.max(min, v)));

const PanelSchema = z.object({
  x: clamp(0, 1),
  y: clamp(0, 1),
  w: clamp(0.02, 1),
  h: clamp(0.02, 1),
  color: hex,
  opacity: clamp(0.15, 1).default(1),
  rotationDeg: clamp(-8, 8).default(0),
});

const HeadlineSchema = z.object({
  lines: z.array(z.string().min(1).max(24)).min(1).max(3),
  color: hex,
  font: z.enum(DESIGN_FONTS).default("anton"),
  align: z.enum(["left", "center", "right"]).default("left"),
  position: z.enum(["top", "middle", "bottom"]).default("bottom"),
  scale: clamp(0.5, 1).default(0.85),
  rotationDeg: clamp(-6, 6).default(0),
  accentWordIndex: z.number().int().min(-1).max(20).default(-1),
});

const SubjectSchema = z.object({
  prompt: z.string().min(8).max(600),
  placement: z.enum(["left", "right", "center"]).default("center"),
  scale: clamp(0.6, 1.15).default(0.95),
  treatment: z.enum(["none", "duotone"]).default("none"),
  duotoneDark: hex.optional(),
  duotoneLight: hex.optional(),
});

const TextureSchema = z.object({
  type: z.enum(["none", "grain", "halftone"]).default("grain"),
  intensity: clamp(0, 1).default(0.35),
});

const DataStripSchema = z.object({
  text: z.string().min(1).max(90),
  position: z.enum(["top", "bottom"]).default("bottom"),
  background: hex,
  color: hex,
});

export const DesignSpecSchema = z.object({
  canvasColor: hex,
  accentColor: hex,
  neutralColor: hex,
  headline: HeadlineSchema,
  subline: z.object({ text: z.string().min(1).max(80), color: hex }).nullable().default(null),
  panels: z.array(PanelSchema).max(4).default([]),
  subject: SubjectSchema,
  texture: TextureSchema.default({ type: "grain", intensity: 0.35 }),
  dataStrip: DataStripSchema.nullable().default(null),
});

export type DesignSpec = z.infer<typeof DesignSpecSchema>;

export interface DesignSpecInput {
  briefText: string;
  headlineText?: string | null;
  brandName?: string;
  brandColors: { primary?: string | null; secondary?: string | null; accent?: string | null };
  persona?: {
    name: string;
    typography?: string | null;
    composition?: string | null;
    colorPhilosophy?: string | null;
    textureAndEffects?: string | null;
    mood?: string | null;
  } | null;
  /** Designer work-sample images (guaranteed style references for the spec). */
  styleReferences?: Array<{ imageBuffer: Buffer; mimeType?: string; description?: string }>;
  aspectRatio: string;
}

const MAX_SPEC_STYLE_REFERENCES = 3;

function personaSection(p: DesignSpecInput["persona"]): string {
  if (!p) return "No specific designer persona — use a bold contemporary sports-graphic sensibility.";
  const parts = [
    `Designer style fingerprint ("Inspired by ${p.name}"):`,
    p.typography && `- Typography: ${p.typography}`,
    p.composition && `- Composition: ${p.composition}`,
    p.colorPhilosophy && `- Color: ${p.colorPhilosophy}`,
    p.textureAndEffects && `- Texture/effects: ${p.textureAndEffects}`,
    p.mood && `- Mood: ${p.mood}`,
  ].filter(Boolean);
  return parts.join("\n");
}

function buildPrompt(input: DesignSpecInput): string {
  const colors = [
    input.brandColors.primary && `primary ${input.brandColors.primary}`,
    input.brandColors.secondary && `secondary ${input.brandColors.secondary}`,
    input.brandColors.accent && `accent ${input.brandColors.accent}`,
  ].filter(Boolean).join(", ") || "no fixed brand palette — choose a bold, cohesive palette";

  return `You are a world-class sports/social graphic designer planning a COMPOSITED layout (like a hype poster: cut-out subject, bold display type, color panels, texture). You output a machine-readable design spec; a deterministic renderer draws it.

BRIEF: ${input.briefText}
${input.headlineText ? `REQUIRED HEADLINE TEXT (use it, you may split into lines): ${input.headlineText}` : "Write a punchy headline (1-3 short lines, max ~14 characters per line, ALL CAPS energy)."}
BRAND: ${input.brandName || "n/a"} — colors: ${colors}
CANVAS ASPECT RATIO: ${input.aspectRatio}

${personaSection(input.persona)}
${(input.styleReferences?.length ?? 0) > 0 ? `\n${input.styleReferences!.slice(0, MAX_SPEC_STYLE_REFERENCES).length} of the designer's actual work samples are attached as images. Study their composition, typography treatment, palette discipline, and texture — your spec must feel like it came from the same designer.\n` : ""}
Return ONLY a JSON object with exactly this shape (all colors 6-digit hex like "#1a1a1a"; all x/y/w/h normalized 0-1 relative to the canvas):
{
  "canvasColor": "...",            // background field color
  "accentColor": "...",
  "neutralColor": "...",           // high-contrast text/neutral color
  "headline": {
    "lines": ["LINE ONE", "LINE TWO"],   // 1-3 lines, each <= 14 chars
    "color": "...",
    "font": "anton" | "archivo" | "barlow",   // anton = tall condensed, archivo = heavy block, barlow = condensed sans
    "align": "left" | "center" | "right",
    "position": "top" | "middle" | "bottom",
    "scale": 0.5-1.0,              // 1.0 = maximum display size
    "rotationDeg": -6 to 6,
    "accentWordIndex": -1          // index of the line to color with accentColor, or -1
  },
  "subline": { "text": "...", "color": "..." } | null,   // small supporting line
  "panels": [                       // 0-4 flat color blocks BEHIND the subject/type
    { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1, "color": "...", "opacity": 0.15-1, "rotationDeg": -8 to 8 }
  ],
  "subject": {
    "prompt": "...",               // vivid description of the hero subject to photograph/render for CUTOUT (single subject, dynamic pose, no background mention)
    "placement": "left" | "right" | "center",
    "scale": 0.6-1.15,             // relative to canvas height
    "treatment": "none" | "duotone",
    "duotoneDark": "...", "duotoneLight": "..."   // only if treatment = duotone
  },
  "texture": { "type": "none" | "grain" | "halftone", "intensity": 0-1 },
  "dataStrip": { "text": "...", "position": "top" | "bottom", "background": "...", "color": "..." } | null
}

Design like a pro: strong hierarchy, intentional negative space, type and subject overlapping for depth, palette discipline. No markdown, JSON only.`;
}

// Deterministic fallback when the LLM output is unusable: a clean, safe layout
// in brand colors so designed mode degrades gracefully instead of failing.
export function fallbackDesignSpec(input: DesignSpecInput): DesignSpec {
  const primary = normalizeHex(input.brandColors.primary) || "#101418";
  const accent = normalizeHex(input.brandColors.accent) || normalizeHex(input.brandColors.secondary) || "#e63946";
  const headlineSource = (input.headlineText || input.briefText || "GAME DAY").toUpperCase();
  const words = headlineSource.split(/\s+/).filter(Boolean).slice(0, 6);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > 14 && current) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
    if (lines.length === 2) break;
  }
  if (current && lines.length < 3) lines.push(current);

  return DesignSpecSchema.parse({
    canvasColor: primary,
    accentColor: accent,
    neutralColor: "#f5f5f0",
    headline: {
      lines: lines.length > 0 ? lines.map(l => l.slice(0, 24)) : ["GAME DAY"],
      color: "#f5f5f0",
      font: "anton",
      align: "left",
      position: "bottom",
      scale: 0.9,
      rotationDeg: 0,
      accentWordIndex: lines.length > 1 ? 1 : -1,
    },
    subline: null,
    panels: [
      { x: 0, y: 0.55, w: 1, h: 0.45, color: accent, opacity: 0.9, rotationDeg: 0 },
    ],
    subject: {
      prompt: input.briefText
        ? `Dynamic athletic hero subject for: ${input.briefText.slice(0, 300)}. Single subject, dramatic action pose, studio sports-photography lighting.`
        : "Dynamic athlete in dramatic action pose, studio sports-photography lighting, single subject.",
      placement: "right",
      scale: 1,
      treatment: "none",
    },
    texture: { type: "grain", intensity: 0.3 },
    dataStrip: null,
  });
}

function normalizeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
}

export async function generateDesignSpec(input: DesignSpecInput): Promise<{ spec: DesignSpec; usedFallback: boolean }> {
  try {
    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];
    for (const ref of (input.styleReferences || []).slice(0, MAX_SPEC_STYLE_REFERENCES)) {
      parts.push({ inlineData: { data: ref.imageBuffer.toString("base64"), mimeType: ref.mimeType || "image/png" } });
    }
    parts.push({ text: buildPrompt(input) });
    const response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_TEXT,
      contents: [{ role: "user", parts }],
    });
    const text = response.candidates?.[0]?.content?.parts
      ?.filter((p: { text?: string }) => p.text)
      .map((p: { text?: string }) => p.text)
      .join("") || "";
    const parsed = DesignSpecSchema.parse(extractJSON(text));
    return { spec: parsed, usedFallback: false };
  } catch (err) {
    console.warn("Design spec generation failed; using fallback spec:", err instanceof Error ? err.message : err);
    return { spec: fallbackDesignSpec(input), usedFallback: true };
  }
}

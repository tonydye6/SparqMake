import sharp from "sharp";
import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS } from "../lib/ai-config.js";

// AI builder for Designer Personas: analyze portfolio screenshots or uploaded
// sample images into the persona's style fingerprint fields. Generalized (not
// Sparq-sports-specific) — personas are account-scoped style inspirations that
// can come from any designer or studio's work.

export interface PersonaFingerprint {
  name: string;
  description: string;
  typography: string;
  composition: string;
  colorPhilosophy: string;
  textureAndEffects: string;
  mood: string;
}

export interface PersonaImageInput {
  buffer: Buffer;
  mimeType: string;
}

// Analysis reads style, not pixels: every sample is downscaled to a bounded
// JPEG before upload so 20 large files can't blow the model's request-size
// limit (and no sample is silently dropped for being too big on disk).
const MAX_ANALYSIS_EDGE_PX = 1280;
const ANALYSIS_JPEG_QUALITY = 80;

async function toAnalysisPart(
  img: PersonaImageInput,
): Promise<{ inlineData: { data: string; mimeType: string } } | null> {
  try {
    const resized = await sharp(img.buffer)
      .resize(MAX_ANALYSIS_EDGE_PX, MAX_ANALYSIS_EDGE_PX, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: ANALYSIS_JPEG_QUALITY })
      .toBuffer();
    return { inlineData: { data: resized.toString("base64"), mimeType: "image/jpeg" } };
  } catch (err) {
    console.warn("Skipping persona sample: could not process image:", err instanceof Error ? err.message : err);
    return null;
  }
}

const PERSONA_ANALYSIS_PROMPT = `You are a senior art director building a "designer style fingerprint" from the provided image(s) of a designer's or studio's work (portfolio screenshots or sample designs).

Distill the DESIGN LANGUAGE — not the literal content — into a reusable style fingerprint that can guide AI image generation to work "in the spirit of" this designer. Be specific and vivid; write each field as direct art-direction prose (no hedging, no meta commentary).

Return a JSON object with exactly these fields:

- "name": A short evocative working name for this style (e.g. "Neo-Brutalist Editorial", "Soft Gradient Minimalism"). Do NOT use any real person's or company's name.
- "description": 1-2 sentences summarizing the overall style for a human browsing a list of style inspirations.
- "typography": The typography language — typeface families/weights, casing, scale contrast, how type is placed and used expressively.
- "composition": Composition philosophy — grids or their absence, negative space, hierarchy, cropping, balance, signature layout moves.
- "colorPhilosophy": Color philosophy — palette character, saturation/contrast strategy, how color creates emphasis or mood.
- "textureAndEffects": Texture and effects — grain, gradients, shadows, materials, print artifacts, 3D, photographic treatment, any signature finishing moves.
- "mood": The emotional register the work projects (e.g. "confident, playful, slightly rebellious").

Return ONLY valid JSON, no markdown code blocks or extra text.`;

export function parsePersonaFingerprint(raw: string): PersonaFingerprint {
  const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse persona analysis response: ${cleaned.slice(0, 200)}`);
  }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: s(parsed.name),
    description: s(parsed.description),
    typography: s(parsed.typography),
    composition: s(parsed.composition),
    colorPhilosophy: s(parsed.colorPhilosophy ?? (parsed as Record<string, unknown>).color_philosophy),
    textureAndEffects: s(parsed.textureAndEffects ?? (parsed as Record<string, unknown>).texture_and_effects),
    mood: s(parsed.mood),
  };
}

export async function analyzePersonaImages(
  images: PersonaImageInput[],
): Promise<PersonaFingerprint> {
  const imageParts = (await Promise.all(images.map(toAnalysisPart))).filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );

  if (imageParts.length === 0) {
    throw new Error("No valid images found for persona analysis");
  }

  const response = await ai.models.generateContent({
    model: AI_MODELS.GEMINI_FLASH_TEXT,
    contents: [
      {
        role: "user",
        parts: [{ text: PERSONA_ANALYSIS_PROMPT }, ...imageParts],
      },
    ],
  });

  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part: { text?: string }) => part.text)
    .map((part: { text?: string }) => part.text)
    .join("") || "";

  return parsePersonaFingerprint(text);
}

import { ai } from "@workspace/integrations-gemini-ai";
import { Modality } from "@google/genai";
import type { AssembledContext } from "./context-assembly.js";
import { AI_MODELS, estimateImagenCost } from "../lib/ai-config.js";
import { INTENT_IMAGE_DIRECTIVES, isIntent } from "../lib/intents.js";
import { MAX_IMAGE_REFERENCES } from "./packet-assembly.js";

export const PLATFORM_CONFIGS: Record<string, { platform: string; aspectRatio: string; width: number; height: number }> = {
  instagram_feed: { platform: "instagram_feed", aspectRatio: "1:1", width: 1080, height: 1080 },
  instagram_story: { platform: "instagram_story", aspectRatio: "9:16", width: 1080, height: 1920 },
  twitter: { platform: "twitter", aspectRatio: "16:9", width: 1200, height: 675 },
  linkedin: { platform: "linkedin", aspectRatio: "1.91:1", width: 1200, height: 628 },
  tiktok: { platform: "tiktok", aspectRatio: "9:16", width: 1080, height: 1920 },
  youtube: { platform: "youtube", aspectRatio: "16:9", width: 1280, height: 720 },
};

export interface ReferenceImage {
  imageBuffer: Buffer;
  mimeType: string;
  role: "subject_reference" | "style_reference";
  description?: string;
  // Where the reference came from: brand-asset packet vs. designer persona.
  // Persona refs get guaranteed slots and persona-specific prompt language.
  source?: "packet" | "persona";
  // Brand asset id for packet-sourced refs, so the prompt builder can tell
  // which packet assets are attached vs. demoted to text descriptors.
  assetId?: string;
}

// Beat 2 (Board) "Vary" constraint modes. The value is stored on the variant
// (creative_variants.vary_mode) and steers how the next generation relates to
// the one it was varied from.
export type VaryMode = "more_like_this" | "keep_style" | "keep_subject";

const VARY_DIRECTIVES: Record<VaryMode, string> = {
  more_like_this:
    "VARIATION DIRECTIVE: Produce a fresh take on the same concept and brand direction. Explore a different composition, angle, or moment while staying clearly on-brand.",
  keep_style:
    "VARIATION DIRECTIVE: Keep the established visual style, color palette, lighting, and overall mood consistent. Vary the subject matter, composition, or scene.",
  keep_subject:
    "VARIATION DIRECTIVE: Keep the primary subject recognizable and consistent. Vary the visual style, treatment, background, and mood around it.",
};

export function buildImagePrompt(ctx: AssembledContext, referenceImages?: ReferenceImage[], varyMode?: VaryMode): string {
  const parts: string[] = [];

  if (ctx.brand.characterStyleRules) {
    parts.push("CHARACTER STYLE CONSTRAINTS:\n" + ctx.brand.characterStyleRules);
  }

  // Taste learning loop: guidance distilled from the team's past decisions
  // (selected takes, rejections, edits, reactions) steers new generations.
  if (ctx.brand.tasteGuidance) {
    parts.push("TEAM TASTE GUIDANCE (learned from this team's past decisions — follow these preferences):\n" + ctx.brand.tasteGuidance);
  }

  const hasPersona = Boolean(ctx.designerPersona);

  if (referenceImages && referenceImages.length > 0) {
    const refDescriptions: string[] = [];
    referenceImages.forEach((ref, i) => {
      const n = `Attached image ${i + 1}`;
      if (ref.source === "persona") {
        refDescriptions.push(`${n} is a work sample by the selected designer — study its composition, layout structure, color treatment, and texture; the final image must feel like it came from the same designer.${ref.description ? ` ${ref.description}` : ""}`);
      } else if (ref.role === "subject_reference") {
        refDescriptions.push(`${n} is a subject that must remain recognizable.${ref.description ? ` ${ref.description}` : ""}`);
      } else if (ref.role === "style_reference") {
        refDescriptions.push(`${n} defines the visual mood and style to emulate.${ref.description ? ` ${ref.description}` : ""}`);
      }
    });
    parts.push("REFERENCE IMAGES:\n" + refDescriptions.join("\n"));

    // Weighted reference system: prompt emphasis aligned with the selected
    // subject-vs-style balance so the language matches the slot allocation.
    // When a designer persona is selected, subject-fidelity language is
    // softened to "keep subjects recognizable" so the persona's style
    // fingerprint stays the dominant art-direction signal.
    const balance = ctx.referenceBalance === "subject" || ctx.referenceBalance === "style" ? ctx.referenceBalance : "balanced";
    if (hasPersona) {
      parts.push(
        "REFERENCE WEIGHTING: The designer's work samples and style fingerprint are the dominant signal — the entire image must be designed in that visual language. Keep the subjects from the subject references clearly recognizable (faces, uniforms, proportions, distinguishing features), but render them fully WITHIN the designer's treatment rather than copying the subject references' original look, lighting, or composition.",
      );
    } else if (balance === "subject") {
      parts.push(
        "REFERENCE WEIGHTING: Prioritize subject fidelity above all. The subject reference images define identity — faces, uniforms, proportions, and distinguishing features must match them closely. Style references are secondary inspiration only; do not let style treatment alter the subject's recognizable identity.",
      );
    } else if (balance === "style") {
      parts.push(
        "REFERENCE WEIGHTING: Prioritize the style references' visual language above all — replicate their color palette, lighting, texture, composition energy, and overall treatment faithfully. Keep the subject recognizable, but render it fully IN that style rather than copying the subject reference's original look and lighting.",
      );
    } else {
      parts.push(
        "REFERENCE WEIGHTING: Balance both — keep the subject clearly recognizable from the subject references while faithfully applying the style references' palette, lighting, and treatment to the whole scene.",
      );
    }
  }

  // Brand coherence: generated subjects must carry THIS brand's identity, not a
  // sibling brand's (production runs showed wrong-brand marks on characters).
  if (ctx.brand?.name) {
    parts.push(
      `BRAND COHERENCE: This image is for the brand "${ctx.brand.name}". Every depicted character, uniform, jersey, signage, and prop must reflect ${ctx.brand.name}'s identity and colors only. Do NOT include names, wordmarks, logos, or identity marks of any other brand or team — even if a reference image shows them, replace them with ${ctx.brand.name}'s identity (or omit them).`,
    );
  }

  // Tiered reference injection: generation assets beyond the attached image
  // references are injected as text descriptors so their content still guides
  // the scene without consuming reference-image slots. Attached-ness is
  // tracked by asset id (persona refs occupy slots but aren't packet assets).
  const attachedAssetIds = new Set(
    (referenceImages || []).map(r => r.assetId).filter((id): id is string => Boolean(id)),
  );
  const descriptorAssets = (ctx.generationPacket?.generationAssets || [])
    .map(g => g.asset)
    .filter(a => !attachedAssetIds.has(a.id))
    .filter(a => a.description || a.styleNotes || (a.depictedEntities || []).length > 0);
  if (descriptorAssets.length > 0) {
    const lines = descriptorAssets.map(a => {
      const bits: string[] = [];
      if (a.description) bits.push(a.description);
      if ((a.depictedEntities || []).length > 0) bits.push(`Depicts: ${(a.depictedEntities || []).join(", ")}`);
      if (a.styleNotes) bits.push(`Style: ${a.styleNotes}`);
      if ((a.colors || []).length > 0) bits.push(`Colors: ${(a.colors || []).join(", ")}`);
      return `- ${a.name}: ${bits.join(" ")}`;
    });
    parts.push("ADDITIONAL BRAND ASSET DESCRIPTORS (not attached as images; incorporate their subjects and look):\n" + lines.join("\n"));
  }

  // Selected design style profile: its art-direction language and color
  // treatment are layered before the brand's imagenPrefix so both apply.
  if (ctx.styleProfile) {
    const styleBits: string[] = [];
    if (ctx.styleProfile.styleDirection) styleBits.push(ctx.styleProfile.styleDirection);
    if (ctx.styleProfile.colorTreatment) styleBits.push(`COLOR TREATMENT: ${ctx.styleProfile.colorTreatment}`);
    if (styleBits.length > 0) {
      parts.push(`DESIGN STYLE — "${ctx.styleProfile.name}":\n` + styleBits.join("\n"));
    }
  }

  // Designer Persona ("Inspired by ..."): when a persona is explicitly
  // selected it is the PRIMARY art-direction block — the model is told to
  // redesign the composition in the persona's language (including
  // graphic-design/composited layouts when the fingerprint implies it),
  // not to treat the persona as secondary inspiration. Brand DNA (colors,
  // coherence, imagenPrefix) still applies.
  if (ctx.designerPersona) {
    const p = ctx.designerPersona;
    const bits: string[] = [];
    if (p.typography) bits.push(`TYPOGRAPHY LANGUAGE: ${p.typography}`);
    if (p.composition) bits.push(`COMPOSITION: ${p.composition}`);
    if (p.colorPhilosophy) bits.push(`COLOR PHILOSOPHY: ${p.colorPhilosophy}`);
    if (p.textureAndEffects) bits.push(`TEXTURE & EFFECTS: ${p.textureAndEffects}`);
    if (p.mood) bits.push(`MOOD: ${p.mood}`);
    if (bits.length > 0) parts.push(
      `PRIMARY ART DIRECTION — designed in the style of "${p.name}":\n` +
      bits.join("\n") + "\n" +
      `DESIGN THE COMPOSITION, don't just render a scene: reinterpret the brief entirely in this designer's visual language. If this designer's fingerprint implies graphic-design treatments — layered graphic panels, bold typographic-style layout structure, collage, treated/duotone photography, geometric framing devices — then produce a designed graphic composition with that structure, NOT a plain photographic scene. Reserve clean negative space and panel structure where headline text would sit (the actual text is overlaid separately later — do not render text yourself). Every choice (framing, palette, texture, lighting, layout) must look like this designer made it.` +
      (ctx.styleProfile
        ? `\nPRECEDENCE: Where this art direction conflicts with the DESIGN STYLE above, this art direction takes precedence for look and feel. Brand identity, brand colors, and brand coherence rules still apply.`
        : ""),
    );
  }

  if (ctx.brand.imagenPrefix) {
    parts.push(ctx.brand.imagenPrefix);
  }

  if (ctx.template.imagenPromptAddition) {
    parts.push(ctx.template.imagenPromptAddition);
  }

  if (ctx.combinedBrief) {
    parts.push(ctx.combinedBrief);
  }

  // Goal-aware posting: the creative's intent steers the image's tone/energy.
  if (ctx.intent && isIntent(ctx.intent)) {
    parts.push(INTENT_IMAGE_DIRECTIVES[ctx.intent]);
  }

  if (varyMode) {
    parts.push(VARY_DIRECTIVES[varyMode]);
  }

  if (ctx.referenceAnalysis) {
    const ref = ctx.referenceAnalysis as Record<string, string>;
    let refText = "REFERENCE INSPIRATION:";
    if (ref.visual_mood) refText += ` Visual mood: ${ref.visual_mood}.`;
    if (ref.color_strategy) refText += ` Color approach: ${typeof ref.color_strategy === 'string' ? ref.color_strategy : JSON.stringify(ref.color_strategy)}.`;
    parts.push(refText);
  }

  parts.push("Do not include any text, words, or letters in the image. Do not render any logos, brand marks, wordmarks, or watermarks — logos are overlaid on the image afterwards.");

  return parts.join("\n\n");
}

export interface ImageGenerationResult {
  platform: string;
  aspectRatio: string;
  imageBuffer: Buffer;
  mimeType: string;
}

// The Gemini image model is stochastic and intermittently returns a response
// with no image part (TEXT-only). That is a transient, retryable failure — not
// a real error — so we re-sample a few times before giving up. Used by every
// flow that calls generateImage (generate, regenerate, vary, takes), keeping
// the retry behavior consistent across the app.
const MAX_IMAGE_ATTEMPTS = 3;
const IMAGE_RETRY_BASE_DELAY_MS = 750;

// Thrown when the image model returns a response containing no image data.
// Distinct type so callers (and the retry loop) can tell a transient empty
// response apart from a genuine API/transport error.
export class NoImageDataError extends Error {
  constructor(public readonly platformKey: string, public readonly attempts: number) {
    super(
      `The image model returned no image for ${platformKey} after ${attempts} attempt${attempts === 1 ? "" : "s"}. ` +
      `This is usually a transient hiccup — please retry.`,
    );
    this.name = "NoImageDataError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestImage(
  contentParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }>,
): Promise<{ data: string; mimeType?: string } | null> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120_000);
  let response;
  try {
    response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_IMAGE,
      contents: [{ role: "user", parts: contentParts }],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        abortSignal: abortController.signal,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    return null;
  }
  return { data: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType };
}

export async function generateImage(
  ctx: AssembledContext,
  platformKey: string,
  referenceImages?: ReferenceImage[],
  varyMode?: VaryMode,
): Promise<ImageGenerationResult> {
  const config = PLATFORM_CONFIGS[platformKey];
  if (!config) throw new Error(`Unknown platform: ${platformKey}`);

  const prompt = buildImagePrompt(ctx, referenceImages, varyMode);
  const fullPrompt = `${prompt}\n\nGenerate this as a ${config.aspectRatio} aspect ratio image suitable for ${config.platform.replace(/_/g, " ")}.`;

  const contentParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];

  const refs = (referenceImages || []).slice(0, MAX_IMAGE_REFERENCES);
  const subjectRefs = refs.filter(r => r.role === "subject_reference");
  const styleRefs = refs.filter(r => r.role === "style_reference");
  const orderedRefs = [...subjectRefs, ...styleRefs];

  for (const ref of orderedRefs) {
    contentParts.push({
      inlineData: {
        data: ref.imageBuffer.toString("base64"),
        mimeType: ref.mimeType || "image/png",
      },
    });
  }

  contentParts.push({ text: fullPrompt });

  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
    const image = await requestImage(contentParts);
    if (image) {
      return {
        platform: config.platform,
        aspectRatio: config.aspectRatio,
        imageBuffer: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType || "image/png",
      };
    }

    // Empty (TEXT-only) response: retry with a short linear backoff unless we
    // have exhausted our attempts. Transport/API errors are NOT caught here, so
    // they propagate immediately rather than burning retries.
    if (attempt < MAX_IMAGE_ATTEMPTS) {
      console.warn(`Image model returned no image data for ${platformKey} (attempt ${attempt}/${MAX_IMAGE_ATTEMPTS}); retrying...`);
      await sleep(IMAGE_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw new NoImageDataError(platformKey, MAX_IMAGE_ATTEMPTS);
}

export async function generateAllImages(
  ctx: AssembledContext,
  platforms: string[],
  onProgress?: (platform: string, status: "started" | "completed" | "failed", error?: string) => void,
  referenceImages?: ReferenceImage[],
): Promise<ImageGenerationResult[]> {
  const results: ImageGenerationResult[] = [];

  const promises = platforms.map(async (platform) => {
    onProgress?.(platform, "started");
    try {
      const result = await generateImage(ctx, platform, referenceImages);
      onProgress?.(platform, "completed");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress?.(platform, "failed", message);
      return null;
    }
  });

  const settled = await Promise.allSettled(promises);
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      results.push(result.value);
    }
  }

  return results;
}

// N1 escalation (generative outpaint): extend the source image's background to a
// target aspect ratio, keeping the subject intact, so reframing no longer clips
// it. Costs one image-model call. Returns the extended image buffer.
export async function outpaintImage(
  rawImageBuffer: Buffer,
  mimeType: string,
  aspectLabel: string,
  sceneHint?: string,
): Promise<Buffer> {
  const prompt = `Extend this image to a ${aspectLabel} aspect ratio. Keep the existing subject exactly as-is and fully visible; seamlessly continue and extend the background and scene to fill the new ${aspectLabel} frame. Do not add any text, words, letters, or watermarks.${sceneHint ? ` Scene context: ${sceneHint}` : ""}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120_000);
  let response;
  try {
    response = await ai.models.generateContent({
      model: AI_MODELS.GEMINI_FLASH_IMAGE,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { data: rawImageBuffer.toString("base64"), mimeType: mimeType || "image/png" } },
            { text: prompt },
          ],
        },
      ],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        abortSignal: abortController.signal,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData,
  );
  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in outpaint response");
  }
  return Buffer.from(imagePart.inlineData.data, "base64");
}

export { estimateImagenCost } from "../lib/ai-config.js";

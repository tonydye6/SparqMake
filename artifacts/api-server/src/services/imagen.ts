import { ai } from "@workspace/integrations-gemini-ai";
import { Modality } from "@google/genai";
import type { AssembledContext } from "./context-assembly.js";
import { AI_MODELS, estimateImagenCost } from "../lib/ai-config.js";

export const PLATFORM_CONFIGS: Record<string, { platform: string; aspectRatio: string; width: number; height: number }> = {
  instagram_feed: { platform: "instagram_feed", aspectRatio: "1:1", width: 1080, height: 1080 },
  instagram_story: { platform: "instagram_story", aspectRatio: "9:16", width: 1080, height: 1920 },
  twitter: { platform: "twitter", aspectRatio: "16:9", width: 1200, height: 675 },
  linkedin: { platform: "linkedin", aspectRatio: "16:9", width: 1200, height: 628 },
  tiktok: { platform: "tiktok", aspectRatio: "9:16", width: 1080, height: 1920 },
};

export interface ReferenceImage {
  imageBuffer: Buffer;
  mimeType: string;
  role: "subject_reference" | "style_reference";
  description?: string;
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

function buildImagePrompt(ctx: AssembledContext, referenceImages?: ReferenceImage[], varyMode?: VaryMode): string {
  const parts: string[] = [];

  if (ctx.brand.characterStyleRules) {
    parts.push("CHARACTER STYLE CONSTRAINTS:\n" + ctx.brand.characterStyleRules);
  }

  if (referenceImages && referenceImages.length > 0) {
    const refDescriptions: string[] = [];
    referenceImages.forEach((ref, i) => {
      const ordinal = i === 0 ? "first" : i === 1 ? "second" : "third";
      if (ref.role === "subject_reference") {
        refDescriptions.push(`The ${ordinal} image is the primary subject that must remain recognizable.${ref.description ? ` ${ref.description}` : ""}`);
      } else if (ref.role === "style_reference") {
        refDescriptions.push(`The ${ordinal} image defines the visual mood and style to emulate.${ref.description ? ` ${ref.description}` : ""}`);
      }
    });
    parts.push("REFERENCE IMAGES:\n" + refDescriptions.join("\n"));
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

  parts.push("Do not include any text, words, or letters in the image. No watermarks.");

  return parts.join("\n\n");
}

export interface ImageGenerationResult {
  platform: string;
  aspectRatio: string;
  imageBuffer: Buffer;
  mimeType: string;
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

  const refs = (referenceImages || []).slice(0, 3);
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
    throw new Error(`No image data in response for ${platformKey}`);
  }

  return {
    platform: config.platform,
    aspectRatio: config.aspectRatio,
    imageBuffer: Buffer.from(imagePart.inlineData.data, "base64"),
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
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

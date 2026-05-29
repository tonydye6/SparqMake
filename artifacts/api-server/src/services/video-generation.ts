import { ai } from "@workspace/integrations-gemini-ai";
import type { AssembledContext } from "./context-assembly.js";
import { AI_MODELS } from "../lib/ai-config.js";

export const VIDEO_CONFIGS: Record<string, { aspectRatio: string; label: string }> = {
  landscape: { aspectRatio: "16:9", label: "Landscape (16:9)" },
  portrait: { aspectRatio: "9:16", label: "Portrait (9:16)" },
};

function buildVideoPrompt(ctx: AssembledContext): string {
  const parts: string[] = [];

  if (ctx.brand.imagenPrefix) {
    parts.push(ctx.brand.imagenPrefix);
  }

  if (ctx.template.imagenPromptAddition) {
    parts.push(ctx.template.imagenPromptAddition);
  }

  if (ctx.combinedBrief) {
    parts.push(ctx.combinedBrief);
  }

  if (ctx.referenceAnalysis) {
    const ref = ctx.referenceAnalysis as Record<string, string>;
    if (ref.visual_mood) parts.push(`Visual mood: ${ref.visual_mood}`);
  }

  parts.push("Create a short, dynamic video clip suitable for social media. No text overlays. Smooth camera motion. High energy.");

  return parts.join("\n\n");
}

export interface VideoGenerationResult {
  orientation: string;
  aspectRatio: string;
  videoBuffer: Buffer;
  mimeType: string;
}

export async function generateVideo(
  ctx: AssembledContext,
  orientation: "landscape" | "portrait",
  signal?: AbortSignal,
): Promise<VideoGenerationResult> {
  const config = VIDEO_CONFIGS[orientation];
  if (!config) throw new Error(`Unknown orientation: ${orientation}`);

  const prompt = buildVideoPrompt(ctx);
  const fullPrompt = `${prompt}\n\nGenerate this as a ${config.aspectRatio} aspect ratio video clip, 5-8 seconds long, for social media.`;

  const operation = await ai.models.generateVideos({
    model: AI_MODELS.VEO_VIDEO,
    prompt: fullPrompt,
    config: {
      aspectRatio: config.aspectRatio,
      numberOfVideos: 1,
      durationSeconds: 6,
      personGeneration: "dont_allow",
    },
  });

  let result = operation;
  while (!result.done) {
    if (signal?.aborted) {
      throw new Error("Video generation cancelled: client disconnected");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    result = await ai.operations.get({ operation: result });
  }

  const generatedVideos = result.response?.generatedVideos;
  if (!generatedVideos || generatedVideos.length === 0) {
    throw new Error(`No video generated for ${orientation}`);
  }

  const video = generatedVideos[0];
  if (!video.video?.uri) {
    throw new Error(`No video URI in response for ${orientation}`);
  }

  const videoResponse = await fetch(video.video.uri, { signal });
  if (!videoResponse.ok) {
    throw new Error(`Failed to download video: ${videoResponse.status}`);
  }
  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

  return {
    orientation,
    aspectRatio: config.aspectRatio,
    videoBuffer,
    mimeType: "video/mp4",
  };
}

export async function generateAllVideos(
  ctx: AssembledContext,
  orientations: Array<"landscape" | "portrait">,
  onProgress?: (orientation: string, status: "started" | "completed" | "failed", error?: string) => void,
): Promise<VideoGenerationResult[]> {
  const results: VideoGenerationResult[] = [];

  for (const orientation of orientations) {
    onProgress?.(orientation, "started");
    try {
      const result = await generateVideo(ctx, orientation);
      onProgress?.(orientation, "completed");
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress?.(orientation, "failed", message);
    }
  }

  return results;
}

export function estimateVideoCost(count: number, durationSec: number = 6): number {
  return count * durationSec * 0.35;
}

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

// Gemini Omni Flash generates video through the Interactions API
// (ai.interactions.create) and returns the finished MP4 as base64 inline data
// in `output_video` — no long-running operation polling or URI download.
interface InteractionVideoResponse {
  status?: string;
  output_video?: { data?: string; mime_type?: string };
}

export async function generateVideo(
  ctx: AssembledContext,
  orientation: "landscape" | "portrait",
  signal?: AbortSignal,
): Promise<VideoGenerationResult> {
  const config = VIDEO_CONFIGS[orientation];
  if (!config) throw new Error(`Unknown orientation: ${orientation}`);

  const prompt = buildVideoPrompt(ctx);
  const fullPrompt = `${prompt}\n\nGenerate this as a ${config.aspectRatio} aspect ratio video clip, 5-8 seconds long, for social media. Do not show people.`;

  const interaction = (await ai.interactions.create({
    model: AI_MODELS.VEO_VIDEO,
    input: fullPrompt,
    response_format: {
      type: "video",
      aspect_ratio: config.aspectRatio as "16:9" | "9:16",
    },
  } as Parameters<typeof ai.interactions.create>[0])) as InteractionVideoResponse;

  if (signal?.aborted) {
    throw new Error("Video generation cancelled: client disconnected");
  }

  const videoData = interaction.output_video?.data;
  if (!videoData) {
    const status = interaction.status || "unknown";
    throw new Error(`No video generated for ${orientation} (interaction status: ${status})`);
  }

  const videoBuffer = Buffer.from(videoData, "base64");
  const mimeType = interaction.output_video?.mime_type || "video/mp4";

  return {
    orientation,
    aspectRatio: config.aspectRatio,
    videoBuffer,
    mimeType,
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

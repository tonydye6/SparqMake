import { ai } from "@workspace/integrations-gemini-ai";
import type { AssembledContext } from "./context-assembly.js";
import { AI_MODELS, COST_ESTIMATES } from "../lib/ai-config.js";

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
  // Sentence-level no-people constraint preserved from Veo path (Interactions API has
  // no personGeneration equivalent — accepted residual risk; documented here).
  const fullPrompt = `${prompt}\n\nGenerate a 6-second social media video clip. Do not show people.`;

  // D1: Wire signal + 300s timeout into the model call using Promise.race so
  // a hung Interactions request is cancelled/timed-out during execution, not
  // detected post-hoc only after the response arrives.
  if (signal?.aborted) throw new Error("Video generation cancelled: client disconnected before start");

  const createPromise = ai.interactions.create({
    model: AI_MODELS.VEO_VIDEO,
    input: fullPrompt,
    response_format: {
      type: "video",
      aspect_ratio: config.aspectRatio as "16:9" | "9:16",
      duration: "6s",
    } as Record<string, unknown>,
    safety_settings: [
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
    ] as unknown as Parameters<typeof ai.interactions.create>[0]["safety_settings"],
  } as unknown as Parameters<typeof ai.interactions.create>[0]);

  const abortPromise = new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("Video generation cancelled: client disconnected"));
    }, { once: true });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("Video generation timed out after 300s"));
    }, 300_000);
  });

  let rawInteraction: unknown;
  try {
    rawInteraction = await Promise.race([createPromise, abortPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  const interaction = rawInteraction as InteractionVideoResponse;

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
  return count * durationSec * COST_ESTIMATES.VIDEO_COST_PER_SECOND_USD;
}

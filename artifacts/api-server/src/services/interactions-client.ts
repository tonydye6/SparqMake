/**
 * Interactions client for Nano Banana Pro (COPILOT_MODELS.NANO_BANANA_MODEL).
 *
 * Uses ai.interactions.create() with previous_interaction_id for targeted
 * preserving edits. Never falls back to a different model — if the model is
 * unavailable the caller receives a thrown error and must surface it.
 *
 * Reference packet slot mapping:
 *   subject assets   -> character/object slots  (role: "character" | "object")
 *   style samples    -> style slots              (role: "style")
 *   persona samples  -> style slots              (role: "style")
 */

import { ai } from "@workspace/integrations-gemini-ai";
import { COPILOT_MODELS } from "../lib/ai-config.js";
import { logger } from "../lib/logger.js";

export interface ImageSlot {
  imageBuffer: Buffer;
  mimeType: string;
  slot: "character" | "object" | "style";
  description?: string;
}

export interface InteractionImageResult {
  interactionId: string;
  imageBuffer: Buffer;
  mimeType: string;
}

interface RawInteractionResponse {
  id?: string;
  status?: string;
  output_image?: { data?: string; mime_type?: string };
  output_video?: { data?: string; mime_type?: string };
}

/**
 * Create or continue an image edit interaction via the Interactions API.
 *
 * - First turn (no previousInteractionId): creates the initial artifact.
 * - Subsequent turns (previousInteractionId set): targeted preserving edit of
 *   the artifact the model already holds — composition stays intact unless the
 *   instruction explicitly asks for a re-roll ("new take").
 */
export interface InteractionVideoResult {
  interactionId: string;
  videoBuffer: Buffer;
  mimeType: string;
}

/**
 * Create or continue a video interaction via Omni Flash.
 *
 * - First call (no previousInteractionId): seeds the model with the current
 *   image to convert it into a video clip.
 * - Subsequent calls (previousInteractionId set): targeted preserving edit on
 *   the video the model already holds.
 */
export async function runVideoInteraction(params: {
  prompt: string;
  imageBuffer?: Buffer | null;
  imageMimeType?: string;
  previousInteractionId?: string | null;
  aspectRatio?: string;
}): Promise<InteractionVideoResult> {
  const { prompt, imageBuffer, imageMimeType, previousInteractionId, aspectRatio = "1:1" } = params;

  const requestBody: Record<string, unknown> = {
    model: COPILOT_MODELS.OMNI_VIDEO_MODEL,
    input: prompt,
    response_format: {
      type: "video",
      aspect_ratio: aspectRatio as "16:9" | "9:16" | "1:1",
    },
  };

  if (imageBuffer) {
    requestBody.media = [{
      data: imageBuffer.toString("base64"),
      mime_type: imageMimeType || "image/png",
      slot: "image_1",
      description: "Seed image for video generation",
    }];
  }

  if (previousInteractionId) {
    requestBody.previous_interaction_id = previousInteractionId;
  }

  logger.debug(
    {
      model: COPILOT_MODELS.OMNI_VIDEO_MODEL,
      hasPreviousInteraction: Boolean(previousInteractionId),
      hasImageSeed: Boolean(imageBuffer),
      aspectRatio,
    },
    "Running video interaction",
  );

  const response = (await ai.interactions.create(
    requestBody as Parameters<typeof ai.interactions.create>[0],
  )) as RawInteractionResponse;

  const videoData = response.output_video?.data;
  if (!videoData) {
    const status = response.status || "unknown";
    throw new Error(
      `Omni Flash returned no video data (status: ${status}). ` +
      `Model: ${COPILOT_MODELS.OMNI_VIDEO_MODEL}. Do not substitute.`,
    );
  }

  const interactionId = response.id;
  if (!interactionId) {
    throw new Error(
      "Video Interactions API returned no interaction id — cannot chain subsequent edits.",
    );
  }

  return {
    interactionId,
    videoBuffer: Buffer.from(videoData, "base64"),
    mimeType: response.output_video?.mime_type || "video/mp4",
  };
}

export async function runImageInteraction(params: {
  prompt: string;
  slots?: ImageSlot[];
  previousInteractionId?: string | null;
  aspectRatio?: string;
}): Promise<InteractionImageResult> {
  const { prompt, slots = [], previousInteractionId, aspectRatio = "1:1" } = params;

  const media = slots.map((s, i) => ({
    data: s.imageBuffer.toString("base64"),
    mime_type: s.mimeType || "image/png",
    slot: `${s.slot}_${i + 1}`,
    description: s.description,
  }));

  const requestBody: Record<string, unknown> = {
    model: COPILOT_MODELS.NANO_BANANA_MODEL,
    input: prompt,
    response_format: {
      type: "image",
      aspect_ratio: aspectRatio,
    },
  };

  if (media.length > 0) {
    requestBody.media = media;
  }

  if (previousInteractionId) {
    requestBody.previous_interaction_id = previousInteractionId;
  }

  logger.debug(
    {
      model: COPILOT_MODELS.NANO_BANANA_MODEL,
      hasPreviousInteraction: Boolean(previousInteractionId),
      slotCount: media.length,
      aspectRatio,
    },
    "Running image interaction",
  );

  const response = (await ai.interactions.create(
    requestBody as Parameters<typeof ai.interactions.create>[0],
  )) as RawInteractionResponse;

  const imageData = response.output_image?.data;
  if (!imageData) {
    const status = response.status || "unknown";
    throw new Error(
      `Nano Banana Pro returned no image data (status: ${status}). ` +
      `Model: ${COPILOT_MODELS.NANO_BANANA_MODEL}. Do not substitute — check model availability.`,
    );
  }

  const interactionId = response.id;
  if (!interactionId) {
    throw new Error(
      "Interactions API returned no interaction id — cannot chain subsequent edits.",
    );
  }

  return {
    interactionId,
    imageBuffer: Buffer.from(imageData, "base64"),
    mimeType: response.output_image?.mime_type || "image/png",
  };
}

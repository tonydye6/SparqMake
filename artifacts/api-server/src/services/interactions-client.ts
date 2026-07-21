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
 *
 * API shape note (SDK 2.12.0+):
 *   Reference images must be passed inside `input` as an array of content blocks
 *   ({ type: "text", text } or { type: "image", data, mime_type }).
 *   The top-level `media` parameter is no longer accepted and returns 400.
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

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string };

/**
 * Build the `input` content block array for an image-generation interaction.
 *
 * The first block is always the text prompt. Any reference image slots are
 * appended as image content blocks. Slot role and description context is
 * embedded in the text prompt so the model understands the reference purpose.
 */
function buildImageInput(prompt: string, slots: ImageSlot[]): ContentBlock[] | string {
  if (slots.length === 0) {
    return prompt;
  }

  const slotDescriptions = slots
    .map((s, i) => {
      const label = s.slot === "character"
        ? "Subject/character reference"
        : s.slot === "object"
          ? "Object reference"
          : "Style reference";
      const desc = s.description ? ` — ${s.description}` : "";
      return `[Image ${i + 1}: ${label}${desc}]`;
    })
    .join(" ");

  const textBlock: ContentBlock = {
    type: "text",
    text: `${prompt}\n\nReference images provided: ${slotDescriptions}`,
  };

  const imageBlocks: ContentBlock[] = slots.map((s) => ({
    type: "image",
    data: s.imageBuffer.toString("base64"),
    mime_type: s.mimeType || "image/png",
  }));

  return [textBlock, ...imageBlocks];
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

  let inputValue: ContentBlock[] | string;
  if (imageBuffer) {
    inputValue = [
      { type: "text", text: prompt },
      {
        type: "image",
        data: imageBuffer.toString("base64"),
        mime_type: imageMimeType || "image/png",
      },
    ];
  } else {
    inputValue = prompt;
  }

  const requestBody: Record<string, unknown> = {
    model: COPILOT_MODELS.OMNI_VIDEO_MODEL,
    input: inputValue,
    response_format: {
      type: "video",
      aspect_ratio: aspectRatio as "16:9" | "9:16" | "1:1",
    },
  };

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

  const inputValue = buildImageInput(prompt, slots);

  const requestBody: Record<string, unknown> = {
    model: COPILOT_MODELS.NANO_BANANA_MODEL,
    input: inputValue,
    response_format: {
      type: "image",
      aspect_ratio: aspectRatio,
    },
  };

  if (previousInteractionId) {
    requestBody.previous_interaction_id = previousInteractionId;
  }

  logger.debug(
    {
      model: COPILOT_MODELS.NANO_BANANA_MODEL,
      hasPreviousInteraction: Boolean(previousInteractionId),
      slotCount: slots.length,
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

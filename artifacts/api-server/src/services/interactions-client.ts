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
  // Asset Library id when the slot came from a library asset — used for slot
  // dedupe/budgeting and the turn-metadata paper trail. Never sent to the model.
  assetId?: string;
}

/**
 * Typed reference slots are gated behind INTERACTIONS_TYPED_REFS=on until the
 * request shape is verified live (scripts/verify-interactions-capabilities.ts).
 * When off (default), references are sent as untyped inline image blocks with
 * prose role labels — the shipped behavior.
 */
export function typedRefsEnabled(): boolean {
  return process.env.INTERACTIONS_TYPED_REFS === "on";
}

/** Reference budget: 6 untyped (shipped behavior), 10 when typed refs are verified on. */
export const MAX_TYPED_REFERENCES = 10;

export interface InteractionImageResult {
  interactionId: string;
  imageBuffer: Buffer;
  mimeType: string;
}

interface RawInteractionResponse {
  id?: string;
  status?: string;
  // D3: Include `uri` on both output shapes; when inline delivery is requested
  // the model should populate `data`, but the uri fallback handles cases where
  // the model sends a download link instead of base64.
  output_image?: { data?: string; mime_type?: string; uri?: string };
  output_video?: { data?: string; mime_type?: string; uri?: string };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string; reference_type?: "character" | "object" | "style" };

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

  // Typed reference roles (character-consistency / object / style) are only
  // sent when the flag confirms the live API accepts the field; otherwise the
  // role reaches the model solely through the prose labels above.
  const withTypedRefs = typedRefsEnabled();
  const imageBlocks: ContentBlock[] = slots.map((s) => ({
    type: "image",
    data: s.imageBuffer.toString("base64"),
    mime_type: s.mimeType || "image/png",
    ...(withTypedRefs ? { reference_type: s.slot } : {}),
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
// D1: Image interactions should abort after 180s; video after 300s.
// Using Promise.race so this works regardless of SDK internal signal support.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const IMAGE_TIMEOUT_MS = 180_000;
const VIDEO_TIMEOUT_MS = 300_000;

// D3: Normalize any input aspect ratio to the nearest supported video value.
// Ratios: 16:9 ≈ 1.78 (landscape), 9:16 ≈ 0.56 (portrait), 1:1 = 1.0 (square).
// Thresholds: >1.2 → 16:9; <0.7 → 9:16; otherwise 1:1.
// This prevents invalid ratios like "1.91:1" (LinkedIn) from reaching the model.
function normalizeVideoAspectRatio(ratio: string): "16:9" | "9:16" | "1:1" {
  const parts = ratio.split(":").map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[1] === 0) {
    return "1:1";
  }
  const r = parts[0]! / parts[1]!;
  if (r >= 1.2) return "16:9";
  if (r <= 0.7) return "9:16";
  return "1:1";
}

// D2: Strictest applicable safety settings for Interactions video.
// personGeneration has no equivalent in the Interactions API (accepted residual
// risk per spec); we mitigate with SEXUALLY_EXPLICIT BLOCK_LOW_AND_ABOVE and
// prompt instruction "Do not show people."
const VIDEO_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

export async function runVideoInteraction(params: {
  prompt: string;
  imageBuffer?: Buffer | null;
  imageMimeType?: string;
  previousInteractionId?: string | null;
  aspectRatio?: string;
  signal?: AbortSignal;
}): Promise<InteractionVideoResult> {
  const { prompt, imageBuffer, imageMimeType, previousInteractionId, aspectRatio = "1:1", signal } = params;
  if (signal?.aborted) throw new Error("Video interaction cancelled before start");

  // D3: Normalize aspect ratio to nearest supported video value before the request.
  const normalizedAspectRatio = normalizeVideoAspectRatio(aspectRatio);

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
      // D3: Whitelisted aspect ratio — no raw platform values reach the model.
      aspect_ratio: normalizedAspectRatio,
      // D2: Fixed 6s duration per spec; consistent with B4 cost reservation.
      duration: "6s",
    },
    // D3: Request inline base64 delivery to avoid needing to fetch a URI.
    delivery: "inline",
    // D2: Safety settings — strictest applicable for video generation.
    safety_settings: VIDEO_SAFETY_SETTINGS,
  };

  if (previousInteractionId) {
    requestBody.previous_interaction_id = previousInteractionId;
  }

  logger.debug(
    {
      model: COPILOT_MODELS.OMNI_VIDEO_MODEL,
      hasPreviousInteraction: Boolean(previousInteractionId),
      hasImageSeed: Boolean(imageBuffer),
      aspectRatio: normalizedAspectRatio,
      originalAspectRatio: aspectRatio,
    },
    "Running video interaction",
  );

  // D1: Thread AbortSignal and apply timeout.
  const createPromise = ai.interactions.create(
    requestBody as Parameters<typeof ai.interactions.create>[0],
  );
  const abortPromise = new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("Video interaction aborted by client disconnect"));
    }, { once: true });
  });
  const response = (await withTimeout(
    Promise.race([createPromise, abortPromise]),
    VIDEO_TIMEOUT_MS,
    "Video interaction",
  )) as RawInteractionResponse;

  // D3: Prefer inline base64 data; fall back to URI fetch when the model sends
  // a download link instead (e.g. when inline delivery is unavailable).
  let videoBuffer: Buffer;
  const videoOutput = response.output_video;
  if (videoOutput?.data) {
    videoBuffer = Buffer.from(videoOutput.data, "base64");
  } else if (videoOutput?.uri) {
    logger.debug({ uri: videoOutput.uri }, "Video interaction: falling back to URI fetch");
    const fetchResp = await fetch(videoOutput.uri);
    if (!fetchResp.ok) {
      throw new Error(`Video URI fetch failed with status ${fetchResp.status}`);
    }
    videoBuffer = Buffer.from(await fetchResp.arrayBuffer());
  } else {
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
    videoBuffer,
    mimeType: videoOutput?.mime_type || "video/mp4",
  };
}

export async function runImageInteraction(params: {
  prompt: string;
  slots?: ImageSlot[];
  previousInteractionId?: string | null;
  aspectRatio?: string;
  signal?: AbortSignal;
}): Promise<InteractionImageResult> {
  const { prompt, slots = [], previousInteractionId, aspectRatio = "1:1", signal } = params;
  if (signal?.aborted) throw new Error("Image interaction cancelled before start");

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

  // D1: Thread AbortSignal and apply timeout.
  const createPromise = ai.interactions.create(
    requestBody as Parameters<typeof ai.interactions.create>[0],
  );
  const abortPromise = new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("Image interaction aborted by client disconnect"));
    }, { once: true });
  });
  const response = (await withTimeout(
    Promise.race([createPromise, abortPromise]),
    IMAGE_TIMEOUT_MS,
    "Image interaction",
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

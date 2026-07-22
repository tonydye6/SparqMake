export const AI_MODELS = {
  CLAUDE_SONNET: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  GEMINI_FLASH_IMAGE: process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image",
  GEMINI_FLASH_TEXT: process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash",
  VEO_VIDEO: process.env.VEO_MODEL || "gemini-omni-flash-preview",
} as const;

// Co-pilot Studio model pins — env-overridable; defaults derive from AI_MODELS so there
// is one source of truth for each model family.
//
// REGISTRY MAP (two config keys can address the same physical model with
// SEPARATE env overrides — overriding one does not move the other):
//   image:  AI_MODELS.GEMINI_FLASH_IMAGE (env GEMINI_IMAGE_MODEL) drives the batch
//           path (imagen.ts: generate/outpaint/cutout/headline); COPILOT_MODELS.
//           NANO_BANANA_MODEL (env NANO_BANANA_MODEL) drives Studio turns.
//   video:  AI_MODELS.VEO_VIDEO (env VEO_MODEL) drives batch video; COPILOT_MODELS.
//           OMNI_VIDEO_MODEL (env OMNI_VIDEO_MODEL) drives Studio video turns.
//   text:   AI_MODELS.GEMINI_FLASH_TEXT (env GEMINI_TEXT_MODEL) drives analysis and
//           design-spec; ART_DIRECTION_MODEL / QA_MODEL pin the Studio director + QA.
// Naming caveat: GEMINI_FLASH_IMAGE currently defaults to a Pro-tier image model
// and VEO_VIDEO to an Omni model — the constant names are historical.
// All Gemini targets require direct GEMINI_API_KEY (proxy does not support them).
// NANO_BANANA_MODEL / OMNI_VIDEO_MODEL: must be called via the Interactions API
// (ai.interactions.create), NOT ai.models.generateContent.
// ART_DIRECTION_MODEL / QA_MODEL: standard generateContent is fine.
export const COPILOT_MODELS = {
  NANO_BANANA_MODEL: process.env.NANO_BANANA_MODEL || AI_MODELS.GEMINI_FLASH_IMAGE,
  OMNI_VIDEO_MODEL: process.env.OMNI_VIDEO_MODEL || AI_MODELS.VEO_VIDEO,
  ART_DIRECTION_MODEL: process.env.ART_DIRECTION_MODEL || AI_MODELS.GEMINI_FLASH_TEXT,
  QA_MODEL: process.env.QA_MODEL || AI_MODELS.GEMINI_FLASH_TEXT,
} as const;

export const COST_ESTIMATES = {
  CLAUDE_CAPTION_USD: Number(process.env.CLAUDE_CAPTION_COST_USD) || 0.01,
  IMAGEN_PER_IMAGE_USD: Number(process.env.IMAGEN_PER_IMAGE_COST_USD) || 0.06,
  GEMINI_TEXT_USD: Number(process.env.GEMINI_TEXT_COST_USD) || 0.002,
  VIDEO_GENERATION_USD: Number(process.env.VIDEO_GENERATION_COST_USD) || 2.10,
  VIDEO_COST_PER_SECOND_USD: Number(process.env.VIDEO_COST_PER_SECOND_USD) || 0.42,
} as const;

/**
 * Estimate video clip duration in seconds from compressed buffer size.
 * Uses ~500 KB/s as a conservative compressed video bitrate.
 * Clamps to a minimum of 3s (shortest meaningful clip).
 */
export function estimateVideoDurationSeconds(bufferBytes: number): number {
  return Math.max(3, Math.round(bufferBytes / 512_000));
}

export function estimateClaudeCost(): number {
  return COST_ESTIMATES.CLAUDE_CAPTION_USD;
}

export function estimateImagenCost(imageCount: number): number {
  return imageCount * COST_ESTIMATES.IMAGEN_PER_IMAGE_USD;
}

export function estimateGeminiTextCost(): number {
  return COST_ESTIMATES.GEMINI_TEXT_USD;
}

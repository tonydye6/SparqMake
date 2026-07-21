export const AI_MODELS = {
  CLAUDE_SONNET: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  GEMINI_FLASH_IMAGE: process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image",
  GEMINI_FLASH_TEXT: process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash",
  VEO_VIDEO: process.env.VEO_MODEL || "gemini-omni-flash-preview",
} as const;

// Co-pilot Studio model pins — env-overridable, no existing generation paths use these yet.
// All three Gemini targets require direct GEMINI_API_KEY (proxy does not support them).
// NANO_BANANA_MODEL / OMNI_VIDEO_MODEL: must be called via the Interactions API
// (directClient.interactions.create), NOT ai.models.generateContent.
// ART_DIRECTION_MODEL / QA_MODEL: standard generateContent is fine.
export const COPILOT_MODELS = {
  NANO_BANANA_MODEL: process.env.NANO_BANANA_MODEL || "gemini-3-pro-image",
  OMNI_VIDEO_MODEL: process.env.OMNI_VIDEO_MODEL || "gemini-omni-flash-preview",
  ART_DIRECTION_MODEL: process.env.ART_DIRECTION_MODEL || "gemini-3.5-flash",
  QA_MODEL: process.env.QA_MODEL || "gemini-3.5-flash",
} as const;

export const COST_ESTIMATES = {
  CLAUDE_CAPTION_USD: Number(process.env.CLAUDE_CAPTION_COST_USD) || 0.01,
  IMAGEN_PER_IMAGE_USD: Number(process.env.IMAGEN_PER_IMAGE_COST_USD) || 0.06,
  GEMINI_TEXT_USD: Number(process.env.GEMINI_TEXT_COST_USD) || 0.002,
} as const;

export function estimateClaudeCost(): number {
  return COST_ESTIMATES.CLAUDE_CAPTION_USD;
}

export function estimateImagenCost(imageCount: number): number {
  return imageCount * COST_ESTIMATES.IMAGEN_PER_IMAGE_USD;
}

export function estimateGeminiTextCost(): number {
  return COST_ESTIMATES.GEMINI_TEXT_USD;
}

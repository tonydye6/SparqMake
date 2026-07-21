export const AI_MODELS = {
  CLAUDE_SONNET: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  GEMINI_FLASH_IMAGE: process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image",
  GEMINI_FLASH_TEXT: process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash",
  VEO_VIDEO: process.env.VEO_MODEL || "gemini-omni-flash-preview",
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

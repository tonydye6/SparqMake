// Brief logo-intent routing: creators often write things like "put the Sparq
// logo in the upper right" straight into the brief. Logos are never rendered
// by the image model (they come out mangled) — they are composited on top of
// the finished image. This module detects logo instructions in a brief so the
// pipeline can (a) strip them from the image prompt, (b) match the mention to
// a real uploaded logo asset, and (c) carry any placement wish into the
// compositing layout.

const LOGO_TERM = /\b(logos?|word\s?marks?|logo\s?marks?|watermarks?|brand\s?marks?)\b/i;

export type LogoPlacementPosition = "top_left" | "top_right" | "bottom_left" | "bottom_right";

export interface LogoAssetLite {
  id: string;
  name: string | null;
}

export interface LogoIntent {
  /** True when the brief talks about a logo at all. */
  mentioned: boolean;
  /** The brand logo asset the mention most plausibly refers to (null = no confident match). */
  matchedAssetId: string | null;
  /** Compositing placement derived from the brief ("upper right corner" etc.). */
  placement: LogoPlacementPosition | null;
}

// Placement phrases mapped onto the four corner anchors compositing supports.
// Vertical-only phrases ("upper third", "at the top") default to the right
// column, matching the compositor's default bottom-right bias.
const PLACEMENT_PATTERNS: Array<{ re: RegExp; position: LogoPlacementPosition }> = [
  { re: /\b(top|upper)[\s-]*(left)\b/i, position: "top_left" },
  { re: /\b(top|upper)[\s-]*(right)\b/i, position: "top_right" },
  { re: /\b(bottom|lower)[\s-]*(left)\b/i, position: "bottom_left" },
  { re: /\b(bottom|lower)[\s-]*(right)\b/i, position: "bottom_right" },
  { re: /\b(upper third|top corner|at the top|on top)\b/i, position: "top_right" },
  { re: /\b(lower third|bottom corner|at the bottom)\b/i, position: "bottom_right" },
];

// Words that carry no identity when matching a mention to a named logo asset.
const GENERIC_TOKENS = new Set([
  "logo", "logos", "mark", "marks", "wordmark", "watermark", "icon", "badge",
  "the", "a", "an", "our", "my", "brand", "primary", "secondary", "main",
  "official", "new", "old", "and", "of", "in", "on", "with", "png", "svg",
  "white", "black", "light", "dark", "version", "v1", "v2",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Sentences (rough split) of the brief that talk about a logo. */
function logoSentences(brief: string): string[] {
  return brief
    .split(/(?<=[.!?\n])\s+|\n+/)
    .filter((s) => LOGO_TERM.test(s));
}

/**
 * Detect a logo instruction in a brief and route it to compositing:
 * matches the mention against the brand's uploaded logo assets by name-token
 * overlap and extracts a corner placement when one is described.
 */
export function detectLogoIntent(brief: string | null | undefined, logoAssets: LogoAssetLite[]): LogoIntent {
  const text = (brief || "").trim();
  if (!text || !LOGO_TERM.test(text)) {
    return { mentioned: false, matchedAssetId: null, placement: null };
  }

  const sentences = logoSentences(text);
  const mentionText = sentences.join(" ");
  const mentionTokens = new Set(tokenize(mentionText));

  // Placement: look in the logo sentences first, so "sunset at the top of the
  // frame ... logo bottom left" resolves to the logo's own placement.
  let placement: LogoPlacementPosition | null = null;
  for (const { re, position } of PLACEMENT_PATTERNS) {
    if (re.test(mentionText)) { placement = position; break; }
  }

  // Match by distinctive name-token overlap ("the Nitro logo" → asset named
  // "Nitro Wordmark"). Generic-only mentions ("add the logo") match nothing
  // and fall through to the default-logo resolution chain.
  let matchedAssetId: string | null = null;
  let bestScore = 0;
  for (const asset of logoAssets) {
    const nameTokens = tokenize(asset.name || "").filter((t) => !GENERIC_TOKENS.has(t));
    const score = nameTokens.filter((t) => mentionTokens.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      matchedAssetId = asset.id;
    }
  }

  return { mentioned: true, matchedAssetId, placement };
}

/**
 * Strip logo-overlay instructions out of a brief before it reaches the image
 * model, and append an explicit "no logos" guard when a mention was removed.
 * Logos are composited after generation; leaving the instruction in the
 * prompt makes the model paint a fake logo we can't remove.
 */
export function sanitizeLogoInstructions(brief: string): string {
  if (!LOGO_TERM.test(brief)) return brief;
  const kept = brief
    .split(/(?<=[.!?\n])\s+|\n+/)
    .filter((s) => !LOGO_TERM.test(s));
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  const guard = "(The brand logo is added to the image afterwards — do not draw any logos, brand marks, or watermarks.)";
  return cleaned ? `${cleaned}\n\n${guard}` : guard;
}

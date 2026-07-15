import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { AssembledContext } from "./context-assembly.js";
import { AI_MODELS, estimateClaudeCost } from "../lib/ai-config.js";
import { extractJSON } from "../lib/extract-json.js";
import { INTENT_COPY_DIRECTIVES, isIntent } from "../lib/intents.js";

export interface CaptionResult {
  instagram_feed: { caption: string; headline: string };
  instagram_story: { caption: string; headline: string };
  twitter: { caption: string; headline: string };
  linkedin: { caption: string; headline: string };
  tiktok: { caption: string; headline: string };
}

function buildSystemPrompt(ctx: AssembledContext): string {
  const { brand } = ctx;
  const hashtagStrategy = brand.hashtagStrategy as Record<string, { always_include?: string[]; [k: string]: unknown }> | null;
  const platformRules = brand.platformRules as Record<string, { char_limit?: number }> | null;
  const bannedTerms = brand.bannedTerms as string[] | null;

  let prompt = `You are generating social media captions and headline overlay text for ${brand.name}, a product by Sparq Games.

VOICE: ${brand.voiceDescription}

`;

  if (bannedTerms && bannedTerms.length > 0) {
    prompt += `NEVER USE THESE WORDS/PHRASES: ${bannedTerms.join(", ")}\n\n`;
  }

  prompt += `TRADEMARK RULES:\n${brand.trademarkRules}\n\n`;

  if (hashtagStrategy) {
    prompt += `HASHTAG STRATEGY:\n`;
    for (const [platform, config] of Object.entries(hashtagStrategy)) {
      const alwaysInclude = config.always_include || [];
      prompt += `- ${platform}: Always include ${alwaysInclude.map((h: string) => `#${h}`).join(", ")}.\n`;
    }
    prompt += "\n";
  }

  if (platformRules) {
    prompt += `PLATFORM CHARACTER LIMITS:\n`;
    for (const [platform, rules] of Object.entries(platformRules)) {
      prompt += `- ${platform}: ${rules.char_limit || 2200} characters maximum, including hashtags\n`;
    }
    prompt += "\n";
  }

  if (ctx.hashtagSets.length > 0) {
    prompt += `AVAILABLE HASHTAG SETS (choose from these rather than inventing hashtags):\n`;
    for (const set of ctx.hashtagSets) {
      const tags = set.hashtags as string[];
      prompt += `- ${set.name} (${set.category}): ${tags.map(h => `#${h}`).join(" ")}\n`;
    }
  }

  return prompt;
}

function buildUserMessage(ctx: AssembledContext): string {
  const { template } = ctx;
  const captionInstruction = template.claudeCaptionInstruction as Record<string, unknown> | null;

  let message = "";

  if (captionInstruction) {
    message += `CAPTION STYLE INSTRUCTIONS:\n${JSON.stringify(captionInstruction, null, 2)}\n\n`;
  }

  if (template.claudeHeadlineInstruction) {
    message += `HEADLINE OVERLAY TEXT INSTRUCTION:\n${template.claudeHeadlineInstruction}\n\n`;
  }

  if (ctx.combinedBrief) {
    message += `ADDITIONAL CONTEXT:\n${ctx.combinedBrief}\n\n`;
  }

  // Goal-aware posting: the creative's intent shapes caption structure/CTA and
  // headline framing across every platform.
  if (ctx.intent && isIntent(ctx.intent)) {
    message += `POST GOAL:\n${INTENT_COPY_DIRECTIVES[ctx.intent]}\n\n`;
  }

  if (ctx.referenceAnalysis) {
    const ref = ctx.referenceAnalysis as Record<string, string>;
    message += `REFERENCE TONE: The user provided a reference URL with the following tonal qualities. Incorporate these influences:\n`;
    if (ref.content_tone) message += `Content tone: ${ref.content_tone}\n`;
    if (ref.sparq_application) message += `Sparq application notes: ${ref.sparq_application}\n`;
    message += "\n";
  }

  message += `Generate captions AND headline overlay text for the following platforms: Instagram feed, Instagram story, Twitter/X, LinkedIn, TikTok.

Return ONLY valid JSON in this exact format:
{
  "instagram_feed": { "caption": "...", "headline": "..." },
  "instagram_story": { "caption": "...", "headline": "..." },
  "twitter": { "caption": "...", "headline": "..." },
  "linkedin": { "caption": "...", "headline": "..." },
  "tiktok": { "caption": "...", "headline": "..." }
}

Each headline should be punchy and different per platform (shorter for Story, more professional for LinkedIn, trendy and hook-driven for TikTok).
Captions must respect each platform's character limit (TikTok: 2200 chars).
Select hashtags from the provided sets — do not invent new ones unless no relevant set exists.`;

  return message;
}

export async function generateCaptions(ctx: AssembledContext): Promise<CaptionResult> {
  const systemPrompt = buildSystemPrompt(ctx);
  const userMessage = buildUserMessage(ctx);

  const response = await anthropic.messages.create(
    {
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 8192,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    },
    { timeout: 120_000 },
  );

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const parsed = extractJSON<CaptionResult>(textBlock.text);

  const defaults = { caption: "", headline: "" };
  return {
    instagram_feed: { ...defaults, ...parsed.instagram_feed },
    instagram_story: { ...defaults, ...parsed.instagram_story },
    twitter: { ...defaults, ...parsed.twitter },
    linkedin: { ...defaults, ...parsed.linkedin },
    tiktok: { ...defaults, ...parsed.tiktok },
  };
}

export { estimateClaudeCost } from "../lib/ai-config.js";

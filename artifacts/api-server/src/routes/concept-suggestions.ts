import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, brandsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AI_MODELS } from "../lib/ai-config.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";
import { INTENTS, INTENT_LABELS, intentPromptCatalog, type Intent } from "../lib/intents.js";

// Beat 1 (Home): brand-aware concept ideation. Stateless — returns ephemeral
// named concept cards the creator picks from before a creative exists. (The
// creative, and the selected concept, are persisted on entering the Board.)
const ConceptSuggestionsBody = z.object({
  brandId: z.string().min(1),
  briefText: z.string().max(2000).optional(),
  count: z.number().int().min(1).max(6).optional(),
});

// The per-concept shape we ask Claude to emit, validated before returning.
const ConceptSchema = z.object({
  title: z.string().min(1).max(120),
  angle: z.string().min(1).max(400),
  // Goal-aware posting: every concept carries the intent it serves.
  intent: z.enum(INTENTS),
});

const router: IRouter = Router();

router.post(
  "/concept-suggestions",
  generationLimiter,
  validateRequest({ body: ConceptSuggestionsBody }),
  async (req: Request, res: Response): Promise<void> => {
    const { brandId, briefText, count = 3 } = req.body as z.infer<typeof ConceptSuggestionsBody>;

    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (!brand) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }

    // Lightweight, brand-only context. The design calls for calendar/gap/launch
    // aware angles; that needs the calendar/plan model (tracked open item) and
    // slots in here later. For now concepts are brand- and brief-aware.
    const brandContext = [
      `BRAND: ${brand.name}`,
      brand.voiceDescription && `VOICE: ${brand.voiceDescription}`,
      brand.characterStyleRules && `CHARACTER/STYLE RULES: ${brand.characterStyleRules}`,
      brand.trademarkRules && `TRADEMARK RULES: ${brand.trademarkRules}`,
      brand.bannedTerms.length > 0 && `NEVER USE THESE TERMS: ${brand.bannedTerms.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");

    const briefLine = briefText?.trim()
      ? `\n\nThe creator's starting brief: "${briefText.trim()}". Bias the concepts toward this brief.`
      : "";

    try {
      const message = await anthropic.messages.create({
        model: AI_MODELS.CLAUDE_SONNET,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `You are a senior social creative strategist for a game studio's brand. Propose ${count} distinct, on-brand social content concepts for the brand below. Each concept is a named creative angle a designer could run with, not a generic platitude.

${brandContext}${briefLine}

Every concept serves exactly one strategic goal (intent) from this taxonomy:
${intentPromptCatalog()}

Rules:
- Each concept must be specific and thematic (a real angle, hook, or series idea), never generic ("engage your audience", "post a meme").
- Honor the brand voice and rules above. Do not use any banned term.
- Do not use em dashes. Use a middot, comma, or colon instead.
- "title" = a short punchy name (2 to 6 words). "angle" = one or two sentences describing the creative idea. "intent" = the taxonomy key the concept serves, and the angle should visibly serve that goal.
- Vary the intents across the set when the brief allows it, so the creator sees a mix of goals.

Respond with ONLY a JSON array of exactly ${count} objects, each {"title": string, "angle": string, "intent": string}. No markdown, no code fence, no preamble.`,
          },
        ],
      });

      const raw = message.content[0].type === "text" ? message.content[0].text.trim() : "";
      const concepts = parseConcepts(raw);
      if (concepts.length === 0) {
        res.status(502).json({ error: "Could not generate concepts. Please try again." });
        return;
      }

      res.json({
        concepts: concepts.map((c, i) => ({
          id: `concept-${i + 1}`,
          ...c,
          intentLabel: INTENT_LABELS[c.intent as Intent],
        })),
      });
    } catch {
      res.status(500).json({ error: "Concept suggestions failed. Please try again." });
    }
  },
);

// Claude is told to emit a bare JSON array, but defensively strip a ```json fence
// and tolerate a wrapping object before validating each item against the schema.
function parseConcepts(raw: string): { title: string; angle: string; intent: Intent }[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { concepts?: unknown }).concepts)
      ? (parsed as { concepts: unknown[] }).concepts
      : [];

  const result: { title: string; angle: string; intent: Intent }[] = [];
  for (const item of arr) {
    const ok = ConceptSchema.safeParse(item);
    if (ok.success) result.push(ok.data);
  }
  return result;
}

export default router;

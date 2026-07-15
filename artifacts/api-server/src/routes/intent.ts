import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, brandsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AI_MODELS } from "../lib/ai-config.js";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";
import { extractJSON } from "../lib/extract-json.js";
import { INTENTS, INTENT_LABELS, INTENT_DESCRIPTIONS, isIntent, intentPromptCatalog, type Intent } from "../lib/intents.js";

// Goal-aware posting: infer the strategic intent behind a brief with Claude.
// Returns the top intent with a confidence plus ranked alternates, which the
// Studio surfaces as a one-tap confirm/adjust chip.
const InferIntentBody = z.object({
  briefText: z.string().min(1).max(4000),
  brandId: z.string().min(1).optional(),
});

const InferenceSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  alternates: z
    .array(z.object({ intent: z.enum(INTENTS), confidence: z.number().min(0).max(1) }))
    .max(3)
    .default([]),
  reasoning: z.string().max(500).optional(),
});

export type IntentInference = z.infer<typeof InferenceSchema>;

const router: IRouter = Router();

// GET the taxonomy so clients render labels from one source of truth.
router.get("/intents", (_req: Request, res: Response): void => {
  res.json({
    intents: INTENTS.map(i => ({ id: i, label: INTENT_LABELS[i], description: INTENT_DESCRIPTIONS[i] })),
  });
});

router.post(
  "/intent-inference",
  generationLimiter,
  validateRequest({ body: InferIntentBody }),
  async (req: Request, res: Response): Promise<void> => {
    const { briefText, brandId } = req.body as z.infer<typeof InferIntentBody>;

    let brandLine = "";
    if (brandId) {
      const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
      if (brand) brandLine = `\nThe brand: ${brand.name}.${brand.voiceDescription ? ` Voice: ${brand.voiceDescription}` : ""}`;
    }

    try {
      const message = await anthropic.messages.create({
        model: AI_MODELS.CLAUDE_SONNET,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `You classify the strategic goal (intent) of a social media post brief. The intent taxonomy:

${intentPromptCatalog()}
${brandLine}

The creator's brief: "${briefText.trim()}"

Pick the single best-fit intent, a confidence between 0 and 1, and up to 2 ranked alternates (only intents that are genuinely plausible). One short sentence of reasoning.

Respond with ONLY JSON: {"intent": string, "confidence": number, "alternates": [{"intent": string, "confidence": number}], "reasoning": string}. No markdown, no code fence.`,
          },
        ],
      });

      const raw = message.content[0]?.type === "text" ? message.content[0].text : "";
      const parsed = InferenceSchema.safeParse(extractJSON(raw));
      if (!parsed.success || !isIntent(parsed.data.intent)) {
        res.status(502).json({ error: "Could not infer an intent. Please try again." });
        return;
      }

      const { intent, confidence, alternates, reasoning } = parsed.data;
      res.json({
        intent,
        label: INTENT_LABELS[intent as Intent],
        confidence,
        alternates: alternates
          .filter(a => a.intent !== intent)
          .map(a => ({ ...a, label: INTENT_LABELS[a.intent as Intent] })),
        reasoning: reasoning ?? null,
      });
    } catch {
      res.status(500).json({ error: "Intent inference failed. Please try again." });
    }
  },
);

export default router;

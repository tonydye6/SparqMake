import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, brandsTable, assetsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { AI_MODELS } from "../lib/ai-config.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";

// N3 dual-path editing: the structured brand spec can be edited directly OR by
// telling an agent what to change in natural language. This endpoint takes an
// instruction + the current brand, and returns a PROPOSED set of changed fields
// for the user to review and Save (confirm/correct) — it never auto-applies.
const AssistBody = z.object({
  instruction: z.string().min(1).max(2000),
});

// The fields the agent may propose changes to (those surfaced on the Brand page).
const ProposalSchema = z
  .object({
    name: z.string().max(120),
    colorPrimary: z.string().max(32),
    colorSecondary: z.string().max(32),
    colorAccent: z.string().max(32),
    colorBackground: z.string().max(32),
    voiceDescription: z.string().max(4000),
    bannedTerms: z.array(z.string().max(120)).max(100),
    trademarkRules: z.string().max(4000),
    characterStyleRules: z.string().max(4000),
    imagenPrefix: z.string().max(2000),
    negativePrompt: z.string().max(2000),
  })
  .partial();

const router: IRouter = Router();

router.post(
  "/brands/:id/assist",
  generationLimiter,
  validateRequest({ body: AssistBody }),
  async (req: Request, res: Response): Promise<void> => {
    const brandId = req.params.id as string;
    const { instruction } = req.body as z.infer<typeof AssistBody>;

    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (!brand) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }

    const current = {
      name: brand.name,
      colorPrimary: brand.colorPrimary,
      colorSecondary: brand.colorSecondary,
      colorAccent: brand.colorAccent,
      colorBackground: brand.colorBackground,
      voiceDescription: brand.voiceDescription,
      bannedTerms: brand.bannedTerms,
      trademarkRules: brand.trademarkRules,
      characterStyleRules: brand.characterStyleRules,
      imagenPrefix: brand.imagenPrefix,
      negativePrompt: brand.negativePrompt,
    };

    try {
      const message = await anthropic.messages.create({
        model: AI_MODELS.CLAUDE_SONNET,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: `You are editing a game studio brand's structured spec. Here is the CURRENT spec as JSON:

${JSON.stringify(current, null, 2)}

Apply this instruction from the brand owner: "${instruction}"

Return ONLY the fields you actually changed, as a single JSON object using the same keys and types as above (colors are hex strings like "#00A19C"; bannedTerms is an array of strings; the rest are strings). Omit any field you did not change. Do not use em dashes. Respond with ONLY the JSON object, no markdown, no code fence, no preamble.`,
          },
        ],
      });

      const raw = message.content[0].type === "text" ? message.content[0].text.trim() : "";
      const proposal = parseProposal(raw);
      if (!proposal || Object.keys(proposal).length === 0) {
        res.status(502).json({ error: "Could not turn that into a change. Try rephrasing." });
        return;
      }

      res.json({ proposal });
    } catch {
      res.status(500).json({ error: "Brand assist failed. Please try again." });
    }
  },
);

const SeedBody = z.object({
  sourceText: z.string().max(20000).optional(),
});

// N3 auto-seed: draft a first-pass brand spec from the brand's existing context
// documents (uploaded brand book / guidelines) plus any pasted source text.
// Returns a PROPOSAL to review (~80% → confirm/correct), never auto-applied.
router.post(
  "/brands/:id/seed",
  generationLimiter,
  validateRequest({ body: SeedBody }),
  async (req: Request, res: Response): Promise<void> => {
    const brandId = req.params.id as string;
    const { sourceText } = req.body as z.infer<typeof SeedBody>;

    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (!brand) {
      res.status(404).json({ error: "Brand not found." });
      return;
    }

    // Pull the brand's uploaded context documents (brand book / guidelines) and
    // combine with any pasted text as the source material.
    const contextAssets = await db
      .select()
      .from(assetsTable)
      .where(and(eq(assetsTable.brandId, brandId), eq(assetsTable.type, "context")));
    const docs = [
      ...contextAssets.map((a) => a.content).filter((c): c is string => !!c && c.trim().length > 0),
      sourceText?.trim() || "",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!docs.trim()) {
      res.status(400).json({ error: "Add brand documents or paste a description to seed from." });
      return;
    }

    try {
      const message = await anthropic.messages.create({
        model: AI_MODELS.CLAUDE_SONNET,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `You are setting up a brand profile for a game studio from its source material below (brand book, guidelines, and/or a description). Draft a first-pass structured spec. OVER-INVEST in voice and tone (the usual weak spot): make "voiceDescription" specific, vivid, and immediately usable for writing social captions.

SOURCE MATERIAL:
"""
${docs.slice(0, 18000)}
"""

Return ONLY a JSON object with these editable fields (omit a field only when the source gives nothing to base it on; colors are hex strings like "#00A19C"; bannedTerms is an array of strings; the rest are strings):
{"name","colorPrimary","colorSecondary","colorAccent","colorBackground","voiceDescription","bannedTerms","trademarkRules","characterStyleRules","imagenPrefix","negativePrompt"}

Do not use em dashes. Respond with ONLY the JSON object, no markdown, no code fence, no preamble.`,
          },
        ],
      });

      const raw = message.content[0].type === "text" ? message.content[0].text.trim() : "";
      const proposal = parseProposal(raw);
      if (!proposal || Object.keys(proposal).length === 0) {
        res.status(502).json({ error: "Could not draft a brand from that material. Try adding more detail." });
        return;
      }

      res.json({ proposal, sources: contextAssets.length });
    } catch {
      res.status(500).json({ error: "Brand seed failed. Please try again." });
    }
  },
);

// Claude is told to return a bare JSON object of changed fields; defensively strip
// a code fence and validate against the editable-field schema before returning.
function parseProposal(raw: string): Partial<z.infer<typeof ProposalSchema>> | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const ok = ProposalSchema.safeParse(parsed);
  return ok.success ? ok.data : null;
}

export default router;

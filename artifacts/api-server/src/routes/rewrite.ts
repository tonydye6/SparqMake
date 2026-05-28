import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { AI_MODELS } from "../lib/ai-config.js";
import { z } from "zod/v4";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";

const RewriteBody = z.object({
  text: z.string().min(1).max(5000),
  instruction: z.string().min(1).max(500),
});

const router: IRouter = Router();

router.post("/rewrite", generationLimiter, validateRequest({ body: RewriteBody }), async (req: Request, res: Response): Promise<void> => {
  const { text, instruction } = req.body;

  try {
    const message = await anthropic.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `You are rewriting a portion of social media caption text. Apply the user's instruction to transform the selected text.

SELECTED TEXT: "${text}"
INSTRUCTION: "${instruction}"

Respond with ONLY the rewritten text. No quotes, no explanation, no preamble. Just the rewritten text.`,
        },
      ],
    });

    const rewritten = message.content[0].type === "text" ? message.content[0].text.trim() : text;

    res.json({ rewritten });
  } catch {
    res.status(500).json({ error: "Rewrite failed. Please try again." });
  }
});

export default router;

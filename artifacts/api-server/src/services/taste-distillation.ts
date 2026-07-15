import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  brandsTable,
  costLogsTable,
  tasteGuidanceVersionsTable,
  tasteSignalsTable,
  type TasteSignal,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { AI_MODELS, estimateClaudeCost } from "../lib/ai-config.js";

// Distillation runs automatically once a brand has accumulated this many
// undistilled signals. It can also be forced from the taste API.
export const DISTILL_THRESHOLD = 15;
// Cap the number of signals sent to the model in a single run.
const MAX_SIGNALS_PER_RUN = 200;

// Per-brand in-process guard so concurrent signal bursts don't launch
// duplicate distillation runs.
const inFlight = new Set<string>();

function describeSignal(s: TasteSignal): string {
  const p = (s.payload || {}) as Record<string, unknown>;
  switch (s.signalType) {
    case "take_selected":
      return `Team SELECTED this generated take as the winner.${p.headline ? ` Headline: "${p.headline}"` : ""}`;
    case "take_passed_over":
      return `Team PASSED OVER this generated take (a sibling was chosen instead).${p.varyMode ? ` It was a "${p.varyMode}" variation.` : ""}`;
    case "vary":
      return `Team asked for a variation of a take in mode "${p.varyMode ?? "unknown"}" (they liked something about it but wanted a change).`;
    case "caption_edit":
      return `Team EDITED an AI caption.\n  Before: ${JSON.stringify(p.before ?? "")}\n  After: ${JSON.stringify(p.after ?? "")}`;
    case "headline_edit":
      return `Team EDITED an AI headline.\n  Before: ${JSON.stringify(p.before ?? "")}\n  After: ${JSON.stringify(p.after ?? "")}`;
    case "regenerate":
      return `Team REGENERATED an image (the previous one wasn't right).${p.reason ? ` Reason: ${p.reason}` : ""}`;
    case "variant_approved":
      return `Team APPROVED a ${p.platform ?? ""} variant.${p.comment ? ` Comment: "${p.comment}"` : ""}`;
    case "variant_rejected":
      return `Team REJECTED a ${p.platform ?? ""} variant. Reason: "${p.comment ?? "none given"}"`;
    case "reaction":
      return `Team reacted "${p.reaction ?? ""}" to a generated ${p.target ?? "item"}.${p.note ? ` Note: "${p.note}"` : ""}`;
    default:
      return `${s.signalType}: ${JSON.stringify(p)}`;
  }
}

// Distill undistilled signals into updated taste guidance for a brand.
// Returns the new guidance text, or null if nothing was done.
export async function distillBrandTaste(brandId: string, opts?: { force?: boolean }): Promise<string | null> {
  if (inFlight.has(brandId)) return null;
  inFlight.add(brandId);
  try {
    const signals = await db.select().from(tasteSignalsTable)
      .where(and(eq(tasteSignalsTable.brandId, brandId), isNull(tasteSignalsTable.distilledAt)))
      .orderBy(tasteSignalsTable.createdAt)
      .limit(MAX_SIGNALS_PER_RUN);

    if (signals.length === 0) return null;
    if (!opts?.force && signals.length < DISTILL_THRESHOLD) return null;

    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (!brand) return null;

    const signalLines = signals.map((s, i) => `${i + 1}. [${s.createdAt.toISOString().slice(0, 10)}] ${describeSignal(s)}`);

    const system = `You are a creative director's assistant. You distill a team's creative decisions into concise, actionable taste guidance for AI content generation (images and social captions) for the brand "${brand.name}".

Rules:
- Output ONLY the guidance text itself: 3-10 short bullet points, each starting with "- ".
- Capture recurring preferences: visual styles they pick vs. pass over, tone/wording they edit toward, things they reject and why.
- Merge with the existing guidance: keep still-valid lessons, drop ones contradicted by new decisions, refine wording.
- Be specific and prescriptive (e.g. "- Prefer bold, high-contrast action shots over static poses"), never vague.
- Do not invent preferences that the signals don't support. If signals are noisy, keep fewer, higher-confidence bullets.`;

    const user = `EXISTING TASTE GUIDANCE (may be empty):
${brand.tasteGuidance || "(none yet)"}

NEW TEAM DECISIONS SINCE LAST DISTILLATION (${signals.length} signals):
${signalLines.join("\n")}

Produce the updated taste guidance.`;

    const response = await anthropic.messages.create(
      {
        model: AI_MODELS.CLAUDE_SONNET,
        max_tokens: 1024,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      },
      { timeout: 120_000 },
    );

    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text" || !textBlock.text.trim()) {
      throw new Error("No text response from distillation model");
    }
    const guidance = textBlock.text.trim();

    const now = new Date();
    const newVersion = await db.transaction(async (tx) => {
      const [updated] = await tx.update(brandsTable)
        .set({
          tasteGuidance: guidance,
          tasteGuidanceVersion: sql`${brandsTable.tasteGuidanceVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(brandsTable.id, brandId))
        .returning({ version: brandsTable.tasteGuidanceVersion });

      await tx.insert(tasteGuidanceVersionsTable).values({
        brandId,
        version: updated.version,
        guidance,
        source: "distilled",
        signalCount: signals.length,
        createdBy: null,
      });

      for (const s of signals) {
        await tx.update(tasteSignalsTable)
          .set({ distilledAt: now })
          .where(eq(tasteSignalsTable.id, s.id));
      }

      return updated.version;
    });

    try {
      await db.insert(costLogsTable).values({
        service: "anthropic",
        operation: "taste_distillation",
        model: AI_MODELS.CLAUDE_SONNET,
        costUsd: estimateClaudeCost(),
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      });
    } catch (err) {
      console.error("Failed to log taste distillation cost:", err instanceof Error ? err.message : err);
    }

    console.log(`Taste guidance v${newVersion} distilled for brand ${brandId} from ${signals.length} signals`);
    return guidance;
  } finally {
    inFlight.delete(brandId);
  }
}

// Background threshold check invoked after each recorded signal. Never throws.
export async function maybeDistillBrandTaste(brandId: string): Promise<void> {
  try {
    await distillBrandTaste(brandId);
  } catch (err) {
    console.error("Taste distillation failed:", err instanceof Error ? err.message : err);
  }
}

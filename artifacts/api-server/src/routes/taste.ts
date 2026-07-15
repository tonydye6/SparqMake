import { Router, type IRouter } from "express";
import { eq, and, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  db,
  brandsTable,
  creativesTable,
  creativeVariantsTable,
  tasteGuidanceVersionsTable,
  tasteSignalsTable,
} from "@workspace/db";
import { str } from "../lib/http-params.js";
import { recordTasteSignal } from "../services/taste-signals.js";
import { distillBrandTaste } from "../services/taste-distillation.js";

const router: IRouter = Router();

// One-tap "why" reaction on a take or variant. Optional free-text note.
const ReactionBody = z.object({
  reaction: z.string().min(1).max(100),
  note: z.string().max(2000).optional(),
  target: z.enum(["take", "variant"]).optional(),
});

router.post("/creatives/:creativeId/variants/:variantId/reaction", async (req, res): Promise<void> => {
  const creativeId = str(req.params.creativeId), variantId = str(req.params.variantId);
  const parsed = ReactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reaction", details: parsed.error.issues });
    return;
  }

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(and(eq(creativeVariantsTable.id, variantId), eq(creativeVariantsTable.creativeId, creativeId)));
  if (!variant) {
    res.status(404).json({ error: "Variant not found for this creative" });
    return;
  }
  const [creative] = await db.select({ brandId: creativesTable.brandId })
    .from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!creative) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  await recordTasteSignal({
    brandId: creative.brandId,
    creativeId,
    variantId,
    signalType: "reaction",
    payload: {
      reaction: parsed.data.reaction,
      note: parsed.data.note || undefined,
      target: parsed.data.target || (variant.platform === "board" ? "take" : "variant"),
      platform: variant.platform,
      varyMode: variant.varyMode || undefined,
    },
    userId: (req as any).user?.id || null,
  });

  res.status(201).json({ ok: true });
});

// "What we've learned" panel: current guidance + version history + signal stats.
router.get("/brands/:id/taste", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const [brand] = await db.select({
    tasteGuidance: brandsTable.tasteGuidance,
    tasteGuidanceVersion: brandsTable.tasteGuidanceVersion,
  }).from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const versions = await db.select().from(tasteGuidanceVersionsTable)
    .where(eq(tasteGuidanceVersionsTable.brandId, brandId))
    .orderBy(desc(tasteGuidanceVersionsTable.version))
    .limit(20);

  const [pending] = await db.select({ count: sql<number>`count(*)::int` })
    .from(tasteSignalsTable)
    .where(and(eq(tasteSignalsTable.brandId, brandId), isNull(tasteSignalsTable.distilledAt)));
  const [total] = await db.select({ count: sql<number>`count(*)::int` })
    .from(tasteSignalsTable)
    .where(eq(tasteSignalsTable.brandId, brandId));

  res.json({
    guidance: brand.tasteGuidance,
    version: brand.tasteGuidanceVersion,
    versions,
    pendingSignals: pending?.count ?? 0,
    totalSignals: total?.count ?? 0,
  });
});

// Manual edit of the guidance — recorded as a new version with source "manual".
const UpdateTasteBody = z.object({
  guidance: z.string().max(10000),
});

router.put("/brands/:id/taste", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const parsed = UpdateTasteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid guidance", details: parsed.error.issues });
    return;
  }
  const guidance = parsed.data.guidance.trim();

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }
  if (guidance === brand.tasteGuidance) {
    res.json({ guidance, version: brand.tasteGuidanceVersion });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx.update(brandsTable)
      .set({
        tasteGuidance: guidance,
        tasteGuidanceVersion: sql`${brandsTable.tasteGuidanceVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(brandsTable.id, brandId))
      .returning({ version: brandsTable.tasteGuidanceVersion });

    await tx.insert(tasteGuidanceVersionsTable).values({
      brandId,
      version: updated.version,
      guidance,
      source: "manual",
      signalCount: 0,
      createdBy: (req as any).user?.id || null,
    });

    return updated;
  });

  res.json({ guidance, version: result.version });
});

// Force a distillation run regardless of the signal threshold.
router.post("/brands/:id/taste/distill", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const [brand] = await db.select({ id: brandsTable.id }).from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  try {
    const guidance = await distillBrandTaste(brandId, { force: true });
    if (guidance === null) {
      res.json({ distilled: false, message: "No new signals to learn from yet." });
      return;
    }
    const [updated] = await db.select({
      tasteGuidance: brandsTable.tasteGuidance,
      tasteGuidanceVersion: brandsTable.tasteGuidanceVersion,
    }).from(brandsTable).where(eq(brandsTable.id, brandId));
    res.json({ distilled: true, guidance: updated.tasteGuidance, version: updated.tasteGuidanceVersion });
  } catch (err) {
    res.status(500).json({ error: `Distillation failed: ${err instanceof Error ? err.message : "unknown error"}` });
  }
});

export default router;

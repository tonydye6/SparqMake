import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db, creativeVariantsTable, creativesTable, refinementLogsTable, assetPairingsTable } from "@workspace/db";
import { recordTasteSignal } from "../services/taste-signals.js";

const router: IRouter = Router();

router.get("/creatives/:creativeId/variants", async (req, res): Promise<void> => {
  const { creativeId } = req.params;
  try {
    const variants = await db
      .select()
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.creativeId, creativeId as string))
      .orderBy(creativeVariantsTable.platform);

    res.json(variants);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch variants" });
  }
});

router.post("/creatives/:creativeId/variants", async (req, res): Promise<void> => {
  const { creativeId } = req.params;
  const { platform, aspectRatio, caption, headlineText } = req.body;

  if (!platform || !aspectRatio) {
    res.status(400).json({ error: "Missing required fields: platform, aspectRatio" });
    return;
  }

  try {
    const [variant] = await db.insert(creativeVariantsTable).values({
      creativeId: creativeId as string,
      platform,
      aspectRatio,
      caption: caption || "",
      originalCaption: caption || "",
      headlineText: headlineText || null,
      originalHeadline: headlineText || null,
    }).returning();

    res.status(201).json(variant);
  } catch (err) {
    res.status(500).json({ error: "Failed to create variant" });
  }
});

router.put("/creatives/:creativeId/variants/:variantId", async (req, res): Promise<void> => {
  const { creativeId, variantId } = req.params;

  try {
    const [existingVariant] = await db.select().from(creativeVariantsTable)
      .where(and(
        eq(creativeVariantsTable.id, variantId as string),
        eq(creativeVariantsTable.creativeId, creativeId as string),
      ));

    if (!existingVariant) {
      res.status(404).json({ error: "Variant not found for this creative" });
      return;
    }

    const newStatus = req.body.status;
    if (newStatus === "rejected" && (!req.body.reviewerComment || !req.body.reviewerComment.trim())) {
      res.status(400).json({ error: "Rejection requires a reviewer comment" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (req.body.caption !== undefined) updates.caption = req.body.caption;
    if (req.body.headlineText !== undefined) updates.headlineText = req.body.headlineText;
    if (newStatus !== undefined) updates.status = newStatus;
    if (req.body.rawImageUrl !== undefined) updates.rawImageUrl = req.body.rawImageUrl;
    if (req.body.compositedImageUrl !== undefined) updates.compositedImageUrl = req.body.compositedImageUrl;

    updates.updatedAt = new Date();

    const [variant] = await db
      .update(creativeVariantsTable)
      .set(updates)
      .where(and(
        eq(creativeVariantsTable.id, variantId as string),
        eq(creativeVariantsTable.creativeId, creativeId as string),
      ))
      .returning();

    if (newStatus === "approved" || newStatus === "rejected") {
      const [camp] = await db.select({ templateId: creativesTable.templateId, brandId: creativesTable.brandId }).from(creativesTable)
        .where(eq(creativesTable.id, creativeId as string));
      if (camp) {
        // Taste learning: approve/reject decisions (with reasons) are the
        // strongest explicit taste signals.
        await recordTasteSignal({
          brandId: camp.brandId,
          creativeId: creativeId as string,
          variantId: variantId as string,
          signalType: newStatus === "approved" ? "variant_approved" : "variant_rejected",
          payload: {
            platform: existingVariant.platform,
            comment: req.body.reviewerComment || undefined,
          },
          userId: (req as any).user?.id || null,
        });
      }
      if (camp?.templateId) {
        await db.insert(refinementLogsTable).values({
          creativeId: creativeId as string,
          templateId: camp.templateId,
          editType: newStatus === "approved" ? "approval" : "rejection",
          platform: existingVariant.platform,
          aspectRatio: existingVariant.aspectRatio,
          newValue: req.body.reviewerComment || null,
          userId: (req as any).user?.id || "system",
        });

        try {
          const pairings = await db.select().from(assetPairingsTable)
            .where(and(
              eq(assetPairingsTable.creativeId, creativeId as string),
              eq(assetPairingsTable.templateId, camp.templateId),
            ));

          for (const pairing of pairings) {
            if (pairing.finalStatus === "approved") continue;

            const updates: Record<string, unknown> = {
              updatedAt: new Date(),
            };

            if (pairing.firstPassApproved === null) {
              updates.firstPassApproved = newStatus === "approved";
            }

            if (newStatus === "approved") {
              updates.finalStatus = "approved";
            } else if (newStatus === "rejected") {
              updates.totalRefinements = sql`${assetPairingsTable.totalRefinements} + 1`;
              updates.finalStatus = "needs_refinement";
            }

            await db.update(assetPairingsTable)
              .set(updates)
              .where(eq(assetPairingsTable.id, pairing.id));
          }
        } catch (err) {
          console.error("Failed to update asset pairings:", err instanceof Error ? err.message : err);
        }
      }
    }

    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: "Failed to update variant" });
  }
});

const bulkUpdateSchema = z.object({
  variantIds: z.array(z.string()).min(1),
  status: z.enum(["approved", "rejected"]),
  reviewerComment: z.string().max(5000).optional(),
});

router.post("/creatives/:creativeId/variants/bulk-update", async (req, res): Promise<void> => {
  const { creativeId } = req.params;

  // 1. Parse and validate request body
  const parseResult = bulkUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body", details: parseResult.error.issues });
    return;
  }

  const { variantIds, status, reviewerComment } = parseResult.data;

  // 2. Rejected status requires a reviewerComment
  if (status === "rejected" && (!reviewerComment || !reviewerComment.trim())) {
    res.status(400).json({ error: "Rejection requires a reviewer comment" });
    return;
  }

  try {
    // 3. Fetch all variants for this campaign and verify all requested IDs belong to it
    const creativeVariants = await db
      .select()
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.creativeId, creativeId as string));

    const creativeVariantIds = new Set(creativeVariants.map((v) => v.id));
    const invalidIds = variantIds.filter((id) => !creativeVariantIds.has(id));
    if (invalidIds.length > 0) {
      res.status(400).json({ error: "Some variant IDs do not belong to this creative" });
      return;
    }

    // Fetch the campaign's templateId once (needed for refinement logs)
    const [camp] = await db
      .select({ templateId: creativesTable.templateId, brandId: creativesTable.brandId })
      .from(creativesTable)
      .where(eq(creativesTable.id, creativeId as string));

    // 4. Run updates in a transaction
    const updated = await db.transaction(async (tx) => {
      const results: { id: string; status: string }[] = [];

      for (const variantId of variantIds) {
        const variant = creativeVariants.find((v) => v.id === variantId)!;

        // 4a. Update variant status (and reviewerComment if rejecting)
        const variantUpdates: Record<string, unknown> = {
          status,
          updatedAt: new Date(),
        };

        const [updatedVariant] = await tx
          .update(creativeVariantsTable)
          .set(variantUpdates)
          .where(
            and(
              eq(creativeVariantsTable.id, variantId),
              eq(creativeVariantsTable.creativeId, creativeId as string),
            ),
          )
          .returning();

        results.push({ id: updatedVariant.id, status: updatedVariant.status });

        // 4b. Create a refinement log entry (matching the single-variant PUT handler pattern)
        if (camp?.templateId) {
          await tx.insert(refinementLogsTable).values({
            creativeId: creativeId as string,
            templateId: camp.templateId,
            editType: status === "approved" ? "approval" : "rejection",
            platform: variant.platform,
            aspectRatio: variant.aspectRatio,
            newValue: reviewerComment || null,
            userId: (req as any).user?.id || "system",
          });
        }
      }

      return results;
    });

    // Taste learning: record each bulk approve/reject decision.
    if (camp) {
      for (const variantId of variantIds) {
        const variant = creativeVariants.find((v) => v.id === variantId)!;
        await recordTasteSignal({
          brandId: camp.brandId,
          creativeId: creativeId as string,
          variantId,
          signalType: status === "approved" ? "variant_approved" : "variant_rejected",
          payload: { platform: variant.platform, comment: reviewerComment || undefined, bulk: true },
          userId: (req as any).user?.id || null,
        });
      }
    }

    // 5. After transaction: check if ALL variants for this campaign are now "approved"
    const allVariantsAfterUpdate = await db
      .select({ status: creativeVariantsTable.status })
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.creativeId, creativeId as string));

    const allApproved = allVariantsAfterUpdate.length > 0 && allVariantsAfterUpdate.every((v) => v.status === "approved");

    let creativeStatus: string;
    if (allApproved) {
      const [updatedCreative] = await db
        .update(creativesTable)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(creativesTable.id, creativeId as string))
        .returning({ status: creativesTable.status });
      creativeStatus = updatedCreative.status;
    } else {
      const [currentCreative] = await db
        .select({ status: creativesTable.status })
        .from(creativesTable)
        .where(eq(creativesTable.id, creativeId as string));
      creativeStatus = currentCreative?.status ?? "unknown";
    }

    // 6. Return updated variants and campaign status
    res.json({ updated, creativeStatus });
  } catch (err) {
    res.status(500).json({ error: "Failed to bulk update variants" });
  }
});

export default router;

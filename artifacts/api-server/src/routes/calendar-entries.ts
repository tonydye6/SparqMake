import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db, calendarEntriesTable, creativesTable, creativeVariantsTable, brandsTable, socialAccountsTable } from "@workspace/db";
import { publishEntry } from "../services/publish-scheduler";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { logger } from "../lib/logger";
import { requireDestructive } from "../middleware/auth.js";
import { recordAudit, actorFromRequest } from "../lib/audit.js";

const CreateCalendarEntryBody = z.object({
  creativeId: z.string().min(1),
  variantId: z.string().min(1),
  platform: z.string().min(1),
  scheduledAt: z.string().min(1),
  socialAccountId: z.string().nullable().optional(),
});

const UpdateCalendarEntryBody = z.object({
  scheduledAt: z.string().optional(),
  publishStatus: z.string().optional(),
  socialAccountId: z.string().nullable().optional(),
  scheduleMethod: z.string().optional(),
});

const IdParams = z.object({ id: z.string().min(1) });

const router: IRouter = Router();

router.get("/calendar-entries", async (req, res): Promise<void> => {
  const { start, end, brandId } = req.query as Record<string, string>;

  let query = db
    .select({
      id: calendarEntriesTable.id,
      creativeId: calendarEntriesTable.creativeId,
      variantId: calendarEntriesTable.variantId,
      platform: calendarEntriesTable.platform,
      socialAccountId: calendarEntriesTable.socialAccountId,
      scheduledAt: calendarEntriesTable.scheduledAt,
      publishedAt: calendarEntriesTable.publishedAt,
      publishStatus: calendarEntriesTable.publishStatus,
      publishError: calendarEntriesTable.publishError,
      retryCount: calendarEntriesTable.retryCount,
      intent: calendarEntriesTable.intent,
      scheduleMethod: calendarEntriesTable.scheduleMethod,
      smartScheduleRationale: calendarEntriesTable.smartScheduleRationale,
      proposalId: calendarEntriesTable.proposalId,
      creativeName: creativesTable.name,
      brandId: creativesTable.brandId,
      brandName: brandsTable.name,
      brandColor: brandsTable.colorPrimary,
      caption: creativeVariantsTable.caption,
      aspectRatio: creativeVariantsTable.aspectRatio,
      compositedImageUrl: creativeVariantsTable.compositedImageUrl,
    })
    .from(calendarEntriesTable)
    .innerJoin(creativesTable, eq(calendarEntriesTable.creativeId, creativesTable.id))
    .innerJoin(brandsTable, eq(creativesTable.brandId, brandsTable.id))
    .innerJoin(creativeVariantsTable, eq(calendarEntriesTable.variantId, creativeVariantsTable.id))
    .$dynamic();

  const conditions = [];
  if (start) conditions.push(gte(calendarEntriesTable.scheduledAt, new Date(start)));
  if (end) conditions.push(lte(calendarEntriesTable.scheduledAt, new Date(end)));
  if (brandId) conditions.push(eq(creativesTable.brandId, brandId));

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const rawLimit = parseInt(req.query.limit as string, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 500) : 200;
  const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

  const entries = await query.orderBy(calendarEntriesTable.scheduledAt).limit(limit).offset(offset);
  res.json({ entries, limit, offset });
});

router.post("/calendar-entries", validateRequest({ body: CreateCalendarEntryBody }), async (req, res): Promise<void> => {
  const { creativeId, variantId, platform, scheduledAt, socialAccountId } = req.body;

  const [creative] = await db.select({ id: creativesTable.id, brandId: creativesTable.brandId, intent: creativesTable.intent })
    .from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!creative) {
    res.status(400).json({ error: "Creative not found" });
    return;
  }

  const [variant] = await db.select({ id: creativeVariantsTable.id, creativeId: creativeVariantsTable.creativeId })
    .from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(400).json({ error: "Variant does not belong to the specified creative" });
    return;
  }

  if (socialAccountId) {
    const [account] = await db.select({ id: socialAccountsTable.id, brandId: socialAccountsTable.brandId, platform: socialAccountsTable.platform })
      .from(socialAccountsTable).where(eq(socialAccountsTable.id, socialAccountId));
    if (!account) {
      res.status(400).json({ error: "Social account not found" });
      return;
    }
    if (account.brandId && account.brandId !== creative.brandId) {
      res.status(400).json({ error: "Social account belongs to a different brand than the creative" });
      return;
    }
  }

  const [entry] = await db.insert(calendarEntriesTable).values({
    creativeId,
    variantId,
    platform,
    scheduledAt: new Date(scheduledAt),
    socialAccountId: socialAccountId || null,
    // Goal-aware posting: snapshot the creative's intent onto the entry.
    intent: creative.intent || null,
  }).returning();

  res.status(201).json(entry);
});

router.put("/calendar-entries/:id", validateRequest({ params: IdParams, body: UpdateCalendarEntryBody }), async (req, res): Promise<void> => {
  const id = str(req.params.id);
  const updates: Record<string, unknown> = {};

  if (req.body.scheduledAt) {
    updates.scheduledAt = new Date(req.body.scheduledAt);

    const [existing] = await db.select({ scheduleMethod: calendarEntriesTable.scheduleMethod })
      .from(calendarEntriesTable).where(eq(calendarEntriesTable.id, id as string));
    if (existing?.scheduleMethod === "smart_schedule") {
      updates.scheduleMethod = "smart_schedule_modified";
    }
  }
  if (req.body.publishStatus) updates.publishStatus = req.body.publishStatus;
  if (req.body.socialAccountId !== undefined) updates.socialAccountId = req.body.socialAccountId;
  if (req.body.scheduleMethod) updates.scheduleMethod = req.body.scheduleMethod;

  updates.updatedAt = new Date();

  const [entry] = await db
    .update(calendarEntriesTable)
    .set(updates)
    .where(eq(calendarEntriesTable.id, id as string))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Calendar entry not found" });
    return;
  }

  res.json(entry);
});

router.post("/calendar-entries/:id/publish", validateRequest({ params: IdParams }), async (req, res): Promise<void> => {
  const id = str(req.params.id);

  const [entry] = await db.select().from(calendarEntriesTable)
    .where(eq(calendarEntriesTable.id, id as string));

  if (!entry) {
    res.status(404).json({ error: "Calendar entry not found" });
    return;
  }

  if (entry.publishStatus === "published") {
    res.status(400).json({ error: "Entry already published" });
    return;
  }

  if (entry.publishStatus === "publishing") {
    res.status(400).json({ error: "Entry is currently being published" });
    return;
  }

  if (!entry.socialAccountId) {
    res.status(400).json({ error: "No social account connected for this entry" });
    return;
  }

  const [account] = await db.select().from(socialAccountsTable)
    .where(eq(socialAccountsTable.id, entry.socialAccountId));

  if (!account) {
    res.status(400).json({ error: "Connected social account not found" });
    return;
  }

  publishEntry(id).catch(err => {
    logger.error({ err, entryId: id }, "Background publish failed");
  });

  res.json({ message: "Publishing initiated", entryId: id });
});

router.post("/calendar-entries/:id/retry", validateRequest({ params: IdParams }), async (req, res): Promise<void> => {
  const id = str(req.params.id);

  const [entry] = await db.select().from(calendarEntriesTable)
    .where(eq(calendarEntriesTable.id, id as string));

  if (!entry) {
    res.status(404).json({ error: "Calendar entry not found" });
    return;
  }

  if (entry.publishStatus !== "failed") {
    res.status(400).json({ error: "Only failed entries can be retried" });
    return;
  }

  await db.update(calendarEntriesTable)
    .set({ publishStatus: "scheduled", publishError: null, retryCount: 0, alertedAt: null, updatedAt: new Date() })
    .where(eq(calendarEntriesTable.id, id as string));

  await recordAudit({
    actor: actorFromRequest(req),
    action: "calendar_entry.retry",
    entityType: "calendar_entry",
    entityIds: [id],
    metadata: { platform: entry.platform, previousError: entry.publishError },
  });

  publishEntry(id).catch(err => {
    logger.error({ err, entryId: id }, "Background retry publish failed");
  });

  res.json({ message: "Retry initiated", entryId: id });
});

router.delete("/calendar-entries/:id", requireDestructive, validateRequest({ params: IdParams }), async (req, res): Promise<void> => {
  const id = str(req.params.id);

  const [entry] = await db
    .delete(calendarEntriesTable)
    .where(eq(calendarEntriesTable.id, id as string))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Calendar entry not found" });
    return;
  }

  await recordAudit({
    actor: actorFromRequest(req),
    action: "calendar_entry.delete",
    entityType: "calendar_entry",
    entityIds: [entry.id],
    metadata: { platform: entry.platform, creativeId: entry.creativeId },
  });

  res.json({ message: "Calendar entry deleted" });
});

const BatchScheduleBodySchema = z.object({
  entries: z.array(
    z.object({
      creativeId: z.string(),
      scheduledAt: z.string(),
      socialAccounts: z.record(z.string(), z.string()).optional(),
    })
  ),
});

router.post("/calendar-entries/batch", async (req, res): Promise<void> => {
  const parseResult = BatchScheduleBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body", details: parseResult.error.issues });
    return;
  }

  const { entries } = parseResult.data;

  // Validate all campaigns exist and are approved
  const creativeIds = entries.map((e) => e.creativeId);
  const campaigns = await db
    .select()
    .from(creativesTable)
    .where(sql`${creativesTable.id} = ANY(${creativeIds})`);

  const creativeMap = new Map(campaigns.map((c) => [c.id, c]));

  for (const entry of entries) {
    const campaign = creativeMap.get(entry.creativeId);
    if (!campaign) {
      res.status(400).json({ error: "Creative not found" });
      return;
    }
    if (campaign.status !== "approved") {
      res.status(400).json({
        error: "Creative is not approved",
      });
      return;
    }
  }

  const created: (typeof calendarEntriesTable.$inferSelect)[] = [];
  const creativesScheduled: string[] = [];

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const variants = await tx
        .select()
        .from(creativeVariantsTable)
        .where(eq(creativeVariantsTable.creativeId, entry.creativeId));

      for (const variant of variants) {
        const socialAccountId = entry.socialAccounts?.[variant.platform] ?? null;

        const [calEntry] = await tx
          .insert(calendarEntriesTable)
          .values({
            creativeId: entry.creativeId,
            variantId: variant.id,
            platform: variant.platform,
            scheduledAt: new Date(entry.scheduledAt),
            socialAccountId,
            // Goal-aware posting: snapshot the creative's intent onto the entry.
            intent: creativeMap.get(entry.creativeId)?.intent || null,
          })
          .returning();

        created.push(calEntry);
      }

      await tx
        .update(creativesTable)
        .set({ status: "scheduled", updatedAt: new Date() })
        .where(eq(creativesTable.id, entry.creativeId));

      creativesScheduled.push(entry.creativeId);
    }
  });

  res.status(201).json({ created, creativesScheduled });
});

export default router;

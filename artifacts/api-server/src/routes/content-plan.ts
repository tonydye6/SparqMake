import { Router, type IRouter } from "express";
import { eq, and, or, sql, SQL, ilike } from "drizzle-orm";
import { db, socialContentPlanItemsTable, brandsTable, templatesTable, creativesTable, type PlanItem } from "@workspace/db";
import multer from "multer";
import { parse as csvParseSync } from "csv-parse/sync";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";

const UpdatePlanItemBody = z.object({
  title: z.string().min(1).max(500).optional(),
  campaignName: z.string().max(500).nullable().optional(),
  primaryPlatform: z.string().min(1).max(50).optional(),
  secondaryPlatforms: z.array(z.string()).optional(),
  templateName: z.string().max(500).nullable().optional(),
  pillar: z.string().max(200).nullable().optional(),
  audience: z.string().max(500).nullable().optional(),
  brandLayer: z.string().max(200).nullable().optional(),
  objective: z.string().max(500).nullable().optional(),
  contentType: z.string().max(200).nullable().optional(),
  assetPacketType: z.string().max(200).nullable().optional(),
  coreMessage: z.string().max(5000).nullable().optional(),
  cta: z.string().max(500).nullable().optional(),
  requiredAssetRoles: z.array(z.string()).optional(),
  plannedWeek: z.string().max(50).nullable().optional(),
  plannedDate: z.string().max(50).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional(),
  linkedCreativeId: z.string().nullable().optional(),
}).strict();

interface AuthenticatedUser {
  id: string;
  [key: string]: unknown;
}


const router: IRouter = Router();

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
});

const VALID_PLATFORMS_LOWER = new Set([
  "instagram", "tiktok", "youtube", "linkedin", "x",
  "facebook", "pinterest", "snapchat", "threads",
]);

const VALID_STATUSES = new Set(["planned", "in_progress", "completed", "cancelled"]);

function isValidPlatform(p: string): boolean {
  return VALID_PLATFORMS_LOWER.has(p.toLowerCase());
}

function parseCSV(text: string): Record<string, string>[] {
  const records: Record<string, string>[] = csvParseSync(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return records;
}

router.post("/content-plan/import", csvUpload.single("file"), async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "CSV file is required" });
    return;
  }

  const csvText = file.buffer.toString("utf-8");
  const rows = parseCSV(csvText);

  if (rows.length === 0) {
    res.status(400).json({ error: "CSV file is empty or has no data rows" });
    return;
  }

  const rejected: { row: number; reason: string }[] = [];
  const validValues: (typeof socialContentPlanItemsTable.$inferInsert)[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    if (!row.title || !row.title.trim()) {
      rejected.push({ row: rowNum, reason: "Missing required field: title" });
      continue;
    }

    if (!row.primary_platform || !row.primary_platform.trim()) {
      rejected.push({ row: rowNum, reason: "Missing required field: primary_platform" });
      continue;
    }

    if (!isValidPlatform(row.primary_platform.trim())) {
      rejected.push({ row: rowNum, reason: `Invalid primary_platform: "${row.primary_platform}"` });
      continue;
    }

    const secondaryPlatforms = row.secondary_platforms
      ? row.secondary_platforms.split("|").map(p => p.trim()).filter(Boolean)
      : [];

    const invalidSecondary = secondaryPlatforms.filter(p => !isValidPlatform(p));
    if (invalidSecondary.length > 0) {
      rejected.push({ row: rowNum, reason: `Invalid secondary platform(s): ${invalidSecondary.join(", ")}` });
      continue;
    }

    const requiredAssetRoles = row.required_asset_roles
      ? row.required_asset_roles.split("|").map(r => r.trim()).filter(Boolean)
      : [];

    validValues.push({
      title: row.title.trim(),
      campaignName: row.campaign_name?.trim() || null,
      primaryPlatform: row.primary_platform.trim(),
      secondaryPlatforms,
      templateName: row.template_name?.trim() || null,
      pillar: row.pillar?.trim() || null,
      audience: row.audience?.trim() || null,
      brandLayer: row.brand_layer?.trim() || null,
      objective: row.objective?.trim() || null,
      contentType: row.content_type?.trim() || null,
      assetPacketType: row.asset_packet_type?.trim() || null,
      coreMessage: row.core_message?.trim() || null,
      cta: row.cta?.trim() || null,
      requiredAssetRoles,
      plannedWeek: row.planned_week?.trim() || null,
      plannedDate: row.planned_date?.trim() || null,
      notes: row.notes?.trim() || null,
    });
  }

  let imported: PlanItem[] = [];

  if (validValues.length > 0) {
    try {
      imported = await db.transaction(async (tx) => {
        return tx.insert(socialContentPlanItemsTable).values(validValues).returning();
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to import content plan items" });
      return;
    }
  }

  res.json({
    imported: imported.length,
    rejected: rejected.length,
    rejectedDetails: rejected,
    items: imported,
  });
});

router.get("/content-plan", async (req, res): Promise<void> => {
  const { pillar, platform, status, plannedWeek, brandLayer } = req.query as Record<string, string | undefined>;

  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

  const conditions: SQL[] = [];
  if (pillar) conditions.push(eq(socialContentPlanItemsTable.pillar, pillar));
  if (platform) conditions.push(eq(socialContentPlanItemsTable.primaryPlatform, platform));
  if (status) conditions.push(eq(socialContentPlanItemsTable.status, status));
  if (plannedWeek) conditions.push(eq(socialContentPlanItemsTable.plannedWeek, plannedWeek));
  if (brandLayer) conditions.push(eq(socialContentPlanItemsTable.brandLayer, brandLayer));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [items, [{ total }]] = await Promise.all([
    whereClause
      ? db.select().from(socialContentPlanItemsTable).where(whereClause).orderBy(socialContentPlanItemsTable.createdAt).limit(limit).offset(offset)
      : db.select().from(socialContentPlanItemsTable).orderBy(socialContentPlanItemsTable.createdAt).limit(limit).offset(offset),
    whereClause
      ? db.select({ total: sql<number>`count(*)::int` }).from(socialContentPlanItemsTable).where(whereClause)
      : db.select({ total: sql<number>`count(*)::int` }).from(socialContentPlanItemsTable),
  ]);

  res.json({ items, total, limit, offset });
});

router.get("/content-plan/:id", async (req, res): Promise<void> => {
  const [item] = await db.select().from(socialContentPlanItemsTable)
    .where(eq(socialContentPlanItemsTable.id, req.params.id));

  if (!item) {
    res.status(404).json({ error: "Plan item not found" });
    return;
  }

  res.json(item);
});

router.post("/content-plan", async (req, res): Promise<void> => {
  const body = req.body;

  if (!body.title?.trim() || !body.primaryPlatform?.trim()) {
    res.status(400).json({ error: "title and primaryPlatform are required" });
    return;
  }

  if (!isValidPlatform(body.primaryPlatform)) {
    res.status(400).json({ error: `Invalid platform: "${body.primaryPlatform}"` });
    return;
  }

  if (body.status && !VALID_STATUSES.has(body.status)) {
    res.status(400).json({ error: "Invalid status value" });
    return;
  }

  const [item] = await db.insert(socialContentPlanItemsTable).values({
    title: body.title.trim(),
    campaignName: body.campaignName || null,
    primaryPlatform: body.primaryPlatform.trim(),
    secondaryPlatforms: body.secondaryPlatforms || [],
    templateName: body.templateName || null,
    pillar: body.pillar || null,
    audience: body.audience || null,
    brandLayer: body.brandLayer || null,
    objective: body.objective || null,
    contentType: body.contentType || null,
    assetPacketType: body.assetPacketType || null,
    coreMessage: body.coreMessage || null,
    cta: body.cta || null,
    requiredAssetRoles: body.requiredAssetRoles || [],
    plannedWeek: body.plannedWeek || null,
    plannedDate: body.plannedDate || null,
    notes: body.notes || null,
  }).returning();

  res.status(201).json(item);
});

router.put("/content-plan/:id", validateRequest({ body: UpdatePlanItemBody }), async (req, res): Promise<void> => {
  const updateFields = req.body as Record<string, unknown>;

  if (updateFields.primaryPlatform && !isValidPlatform(updateFields.primaryPlatform as string)) {
    res.status(400).json({ error: `Invalid platform: "${updateFields.primaryPlatform}"` });
    return;
  }

  const [item] = await db.update(socialContentPlanItemsTable)
    .set({ ...updateFields, updatedAt: new Date() })
    .where(eq(socialContentPlanItemsTable.id, req.params.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Plan item not found" });
    return;
  }

  res.json(item);
});

router.delete("/content-plan/:id", async (req, res): Promise<void> => {
  const [item] = await db.delete(socialContentPlanItemsTable)
    .where(eq(socialContentPlanItemsTable.id, req.params.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Plan item not found" });
    return;
  }

  res.json({ deleted: true });
});

router.post("/content-plan/:id/create-creative", async (req, res): Promise<void> => {
  const [planItem] = await db.select().from(socialContentPlanItemsTable)
    .where(eq(socialContentPlanItemsTable.id, req.params.id));

  if (!planItem) {
    res.status(404).json({ error: "Plan item not found" });
    return;
  }

  if (planItem.linkedCreativeId) {
    res.status(400).json({ error: "Plan item already has a linked creative" });

    return;
  }

  let brandId: string | null = null;
  if (planItem.brandLayer) {
    const layerKey = planItem.brandLayer.toLowerCase();
    const [match] = await db.select().from(brandsTable)
      .where(or(
        eq(brandsTable.name, planItem.brandLayer),
        eq(brandsTable.slug, layerKey),
      ))
      .limit(1);
    if (match) {
      brandId = match.id;
    } else {
      res.status(400).json({ error: `Brand "${planItem.brandLayer}" not found. Please check the brand name and try again.` });
      return;
    }
  } else {
    const [firstBrand] = await db.select().from(brandsTable).limit(1);
    if (firstBrand) {
      brandId = firstBrand.id;
    } else {
      res.status(400).json({ error: "No brand found. Please create a brand first." });
      return;
    }
  }

  let templateId: string | null = null;
  if (planItem.templateName) {
    const [match] = await db.select().from(templatesTable)
      .where(ilike(templatesTable.name, planItem.templateName))
      .limit(1);
    if (match) templateId = match.id;
  }

  const userId = ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || "system";

  try {
    const result = await db.transaction(async (tx) => {
      const [campaign] = await tx.insert(creativesTable).values({
        brandId: brandId!,
        templateId,
        name: planItem.title,
        status: "draft",
        briefText: planItem.coreMessage || "",
        createdBy: userId,
      }).returning();

      await tx.update(socialContentPlanItemsTable)
        .set({
          status: "in_progress",
          linkedCreativeId: campaign.id,
          updatedAt: new Date(),
        })
        .where(eq(socialContentPlanItemsTable.id, planItem.id));

      return campaign;
    });

    res.status(201).json({
      creative: result,
      planItem: {
        ...planItem,
        status: "in_progress",
        linkedCreativeId: result.id,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to create creative" });
  }
});

export default router;

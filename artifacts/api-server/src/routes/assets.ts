import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, ne, and, ilike, or, inArray, desc, sql, arrayContains } from "drizzle-orm";
import { db, assetsTable, creativesTable } from "@workspace/db";
import {
  GetAssetsQueryParams,
  CreateAssetBody,
  GetAssetParams,
  GetAssetsResponse,
  GetAssetResponse,
  UpdateAssetParams,
  UpdateAssetBody,
  UpdateAssetResponse,
  DeleteAssetParams,
  DeleteAssetResponse,
} from "@workspace/api-zod";
import { backfillAssetClassifications } from "../services/backfill-assets.js";
import { validateRequest } from "../middleware/validate.js";
import { deleteObject, resolveUrl } from "../services/storage.js";
import { requireBulkMutation, requireDestructive } from "../middleware/auth.js";
import { recordAudit, actorFromRequest } from "../lib/audit.js";

/** Soft-delete the storage objects backing an asset row (fileUrl + thumbnailUrl). */
async function deleteAssetObjects(rows: { fileUrl: string | null; thumbnailUrl: string | null }[]): Promise<void> {
  for (const row of rows) {
    for (const url of [row.fileUrl, row.thumbnailUrl]) {
      const loc = resolveUrl(url);
      if (loc) await deleteObject(loc);
    }
  }
}

interface AuthenticatedUser {
  id: string;
  [key: string]: unknown;
}


const router: IRouter = Router();

router.get("/assets", async (req, res): Promise<void> => {
  const query = GetAssetsQueryParams.safeParse(req.query);
  const conditions = [];

  if (query.success) {
    if (query.data.brandId) conditions.push(eq(assetsTable.brandId, query.data.brandId));
    if (query.data.type) conditions.push(eq(assetsTable.type, query.data.type));
    if (query.data.status) {
      conditions.push(eq(assetsTable.status, query.data.status));
    } else {
      // Archived assets are hidden by default; only returned when explicitly
      // requested via ?status=archived.
      conditions.push(ne(assetsTable.status, "archived"));
    }
    if (query.data.search) {
      conditions.push(
        or(
          ilike(assetsTable.name, `%${query.data.search}%`),
          ilike(assetsTable.description, `%${query.data.search}%`)
        )!
      );
    }
  }

  const assetClass = req.query.assetClass as string | undefined;
  if (assetClass) conditions.push(eq(assetsTable.assetClass, assetClass));

  const generationAllowed = req.query.generationAllowed as string | undefined;
  if (generationAllowed === "true") conditions.push(eq(assetsTable.generationAllowed, true));
  if (generationAllowed === "false") conditions.push(eq(assetsTable.generationAllowed, false));

  const compositingOnly = req.query.compositingOnly as string | undefined;
  if (compositingOnly === "true") conditions.push(eq(assetsTable.compositingOnly, true));
  if (compositingOnly === "false") conditions.push(eq(assetsTable.compositingOnly, false));

  const franchise = req.query.franchise as string | undefined;
  if (franchise) conditions.push(eq(assetsTable.franchise, franchise));

  const approvedTemplate = req.query.approvedTemplate as string | undefined;
  if (approvedTemplate) conditions.push(sql`${assetsTable.approvedTemplates} @> ARRAY[${approvedTemplate}]::text[]`);

  const approvedChannel = req.query.approvedChannel as string | undefined;
  if (approvedChannel) conditions.push(sql`${assetsTable.approvedChannels} @> ARRAY[${approvedChannel}]::text[]`);

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const baseCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetsTable)
    .where(baseCondition);
  const total = countResult?.count ?? 0;

  const results = baseCondition
    ? await db.select().from(assetsTable).where(baseCondition).orderBy(assetsTable.createdAt).limit(limit).offset(offset)
    : await db.select().from(assetsTable).orderBy(assetsTable.createdAt).limit(limit).offset(offset);

  res.json({ data: results, total, limit, offset });
});

router.post("/assets", validateRequest({ body: CreateAssetBody }), async (req, res): Promise<void> => {
  const userId = ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || "system";
  const [asset] = await db.insert(assetsTable).values({ ...req.body, uploadedBy: userId }).returning();
  res.status(201).json(GetAssetResponse.parse(asset));
});

const VALID_ASSET_STATUSES = ["uploaded", "approved", "archived"];

router.post("/assets/bulk-update", requireBulkMutation, async (req, res): Promise<void> => {
  const { ids, status, tags } = req.body as {
    ids?: string[];
    status?: string;
    tags?: string[];
  };

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required and must not be empty" });
    return;
  }

  if (status && !VALID_ASSET_STATUSES.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_ASSET_STATUSES.join(", ")}` });
    return;
  }

  if (tags && (!Array.isArray(tags) || tags.some(t => typeof t !== "string"))) {
    res.status(400).json({ error: "tags must be an array of strings" });
    return;
  }

  if (!status && (!tags || tags.length === 0)) {
    res.status(400).json({ error: "At least one of status or tags must be provided" });
    return;
  }

  if (tags && tags.length > 0) {
    const existing = await db.select().from(assetsTable).where(inArray(assetsTable.id, ids));
    const allResults = [];
    for (const asset of existing) {
      const existingTags = (asset.tags || []) as string[];
      const merged = [...new Set([...existingTags, ...tags])];
      const updateData: Record<string, unknown> = { tags: merged, updatedAt: new Date() };
      if (status) {
        updateData.status = status;
        if (status === "approved") updateData.approvedAt = new Date();
      }
      const [updated] = await db
        .update(assetsTable)
        .set(updateData)
        .where(eq(assetsTable.id, asset.id))
        .returning();
      if (updated) allResults.push(updated);
    }
    res.json({ updated: allResults.length, assets: allResults });
    return;
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (status) {
    updateData.status = status;
    if (status === "approved") updateData.approvedAt = new Date();
  }

  const results = await db
    .update(assetsTable)
    .set(updateData)
    .where(inArray(assetsTable.id, ids))
    .returning();

  res.json({ updated: results.length, assets: results });
});

router.post("/assets/bulk-delete", requireBulkMutation, async (req, res): Promise<void> => {
  const { ids } = req.body as { ids?: string[] };

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required and must not be empty" });
    return;
  }

  const deleted = await db
    .delete(assetsTable)
    .where(inArray(assetsTable.id, ids))
    .returning();

  await recordAudit({
    actor: actorFromRequest(req),
    action: "asset.bulk_delete",
    entityType: "asset",
    entityIds: deleted.map((a) => a.id),
    affectedCount: deleted.length,
    metadata: { requestedIds: ids.length },
  });

  await deleteAssetObjects(deleted);

  res.json({ deleted: deleted.length });
});

router.get("/assets/recommended", async (req, res): Promise<void> => {
  const { brandId, templateId, role } = req.query as { brandId?: string; templateId?: string; role?: string };

  const conditions = [];
  if (brandId) conditions.push(eq(assetsTable.brandId, brandId));
  conditions.push(eq(assetsTable.status, "approved"));
  if (role === "subject_reference") {
    conditions.push(eq(assetsTable.assetClass, "subject_reference"));
  } else if (role === "style_reference") {
    conditions.push(eq(assetsTable.assetClass, "style_reference"));
  } else if (role === "compositing") {
    conditions.push(eq(assetsTable.assetClass, "compositing"));
  }

  let results;
  if (conditions.length > 0) {
    results = await db.select().from(assetsTable).where(and(...conditions)).orderBy(assetsTable.createdAt);
  } else {
    results = await db.select().from(assetsTable).where(eq(assetsTable.status, "approved")).orderBy(assetsTable.createdAt);
  }

  const scored = results.map((asset, index) => {
    let relevanceScore = 0.5;
    if (role === "subject_reference" && asset.subjectIdentityScore) {
      relevanceScore = asset.subjectIdentityScore;
    } else if (role === "style_reference" && asset.styleStrengthScore) {
      relevanceScore = asset.styleStrengthScore;
    } else if (asset.assetClass === role) {
      relevanceScore = 0.8;
    }
    if (asset.generationAllowed === false) relevanceScore *= 0.1;
    if (templateId && asset.approvedTemplates && (asset.approvedTemplates as string[]).includes(templateId)) {
      relevanceScore += 0.2;
    }
    return { ...asset, relevanceScore: Math.min(relevanceScore, 1) };
  });

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  res.json(scored);
});

router.get("/assets/:id", validateRequest({ params: GetAssetParams }), async (req, res): Promise<void> => {
  const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, str(req.params.id)));
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  res.json(GetAssetResponse.parse(asset));
});

router.put("/assets/:id", validateRequest({ params: UpdateAssetParams, body: UpdateAssetBody }), async (req, res): Promise<void> => {
  const updateData: Record<string, unknown> = { ...req.body, updatedAt: new Date() };

  if (req.body.status === "approved" && req.body.approvedBy) {
    updateData.approvedAt = new Date();
  }

  const [asset] = await db
    .update(assetsTable)
    .set(updateData)
    .where(eq(assetsTable.id, str(req.params.id)))
    .returning();

  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  res.json(UpdateAssetResponse.parse(asset));
});

router.put("/assets/:id/metadata", async (req, res): Promise<void> => {
  const assetId = str(req.params.id);
  const {
    assetClass,
    generationRole,
    brandLayer,
    franchise,
    approvedChannels,
    approvedTemplates,
    subjectIdentityScore,
    styleStrengthScore,
    compositingOnly,
    generationAllowed,
    approvedForCompositing,
    referencePriorityDefault,
    conflictTags,
    freshnessScore,
  } = req.body;

  const validAssetClasses = ["compositing", "subject_reference", "style_reference", "context"];
  if (assetClass !== undefined && !validAssetClasses.includes(assetClass)) {
    res.status(400).json({ error: `Invalid assetClass. Must be one of: ${validAssetClasses.join(", ")}` });
    return;
  }

  const scoreFields = { subjectIdentityScore, styleStrengthScore, referencePriorityDefault, freshnessScore };
  for (const [field, value] of Object.entries(scoreFields)) {
    if (value !== undefined && (typeof value !== "number" || value < 1 || value > 5)) {
      res.status(400).json({ error: `${field} must be a number between 1 and 5` });
      return;
    }
  }

  if (approvedChannels !== undefined && !Array.isArray(approvedChannels)) {
    res.status(400).json({ error: "approvedChannels must be an array of strings" });
    return;
  }
  if (approvedTemplates !== undefined && !Array.isArray(approvedTemplates)) {
    res.status(400).json({ error: "approvedTemplates must be an array of strings" });
    return;
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (assetClass !== undefined) updateData.assetClass = assetClass;
  if (generationRole !== undefined) updateData.generationRole = generationRole;
  if (brandLayer !== undefined) updateData.brandLayer = brandLayer;
  if (franchise !== undefined) updateData.franchise = franchise;
  if (approvedChannels !== undefined) updateData.approvedChannels = approvedChannels;
  if (approvedTemplates !== undefined) updateData.approvedTemplates = approvedTemplates;
  if (subjectIdentityScore !== undefined) updateData.subjectIdentityScore = subjectIdentityScore;
  if (styleStrengthScore !== undefined) updateData.styleStrengthScore = styleStrengthScore;
  if (compositingOnly !== undefined) updateData.compositingOnly = compositingOnly;
  if (generationAllowed !== undefined) updateData.generationAllowed = generationAllowed;
  if (approvedForCompositing !== undefined) updateData.approvedForCompositing = approvedForCompositing;
  if (referencePriorityDefault !== undefined) updateData.referencePriorityDefault = referencePriorityDefault;
  if (conflictTags !== undefined) updateData.conflictTags = conflictTags;
  if (freshnessScore !== undefined) updateData.freshnessScore = freshnessScore;

  const [asset] = await db
    .update(assetsTable)
    .set(updateData)
    .where(eq(assetsTable.id, assetId))
    .returning();

  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  res.json(asset);
});

router.delete("/assets/:id", requireDestructive, validateRequest({ params: DeleteAssetParams }), async (req, res): Promise<void> => {
  const [asset] = await db.delete(assetsTable).where(eq(assetsTable.id, str(req.params.id))).returning();
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  await recordAudit({
    actor: actorFromRequest(req),
    action: "asset.delete",
    entityType: "asset",
    entityIds: [asset.id],
    brandId: asset.brandId,
    metadata: { name: asset.name },
  });

  await deleteAssetObjects([asset]);

  res.json(DeleteAssetResponse.parse({ message: "Asset deleted" }));
});

router.get("/assets/:id/usage", async (req, res): Promise<void> => {
  const assetId = str(req.params.id);

  const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, assetId));
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const usedIn = await db
    .select({
      id: creativesTable.id,
      name: creativesTable.name,
      status: creativesTable.status,
      createdAt: creativesTable.createdAt,
    })
    .from(creativesTable)
    .where(sql`${creativesTable.selectedAssets}::jsonb @> ${JSON.stringify([{ assetId }])}::jsonb`)
    .orderBy(creativesTable.createdAt);

  res.json(usedIn);
});

router.post("/assets/backfill", async (_req, res): Promise<void> => {
  try {
    const result = await backfillAssetClassifications();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Backfill failed: ${message}` });
  }
});

export default router;

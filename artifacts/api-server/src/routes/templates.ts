import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, templatesTable, templateVersionsTable, templateRecommendationsTable, refinementLogsTable } from "@workspace/db";
import {
  GetTemplatesQueryParams,
  CreateTemplateBody,
  GetTemplateParams,
  GetTemplatesResponse,
  GetTemplateResponse,
  UpdateTemplateParams,
  UpdateTemplateBody,
  UpdateTemplateResponse,
  DeleteTemplateParams,
  DeleteTemplateResponse,
} from "@workspace/api-zod";
import { analyzeTemplate } from "../services/refinement-analysis.js";
import { validateRequest } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";

const router: IRouter = Router();

router.get("/templates", async (req, res): Promise<void> => {
  const query = GetTemplatesQueryParams.safeParse(req.query);
  const conditions = [];

  if (query.success && query.data.brandId) {
    conditions.push(eq(templatesTable.brandId, query.data.brandId));
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const baseCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(templatesTable)
    .where(baseCondition);
  const total = countResult?.count ?? 0;

  const results = baseCondition
    ? await db.select().from(templatesTable).where(baseCondition).orderBy(templatesTable.createdAt).limit(limit).offset(offset)
    : await db.select().from(templatesTable).orderBy(templatesTable.createdAt).limit(limit).offset(offset);

  res.json({ data: results, total, limit, offset });
});

router.post("/templates", validateRequest({ body: CreateTemplateBody }), async (req, res): Promise<void> => {
  const [template] = await db.insert(templatesTable).values(req.body).returning();
  res.status(201).json(GetTemplateResponse.parse(template));
});

router.get("/templates/:id", validateRequest({ params: GetTemplateParams }), async (req, res): Promise<void> => {
  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, str(req.params.id)));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.json(GetTemplateResponse.parse(template));
});

router.put("/templates/:id", validateRequest({ params: UpdateTemplateParams, body: UpdateTemplateBody }), async (req, res): Promise<void> => {
  const [existing] = await db.select().from(templatesTable).where(eq(templatesTable.id, str(req.params.id)));
  if (!existing) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const changedFields = Object.keys(req.body).filter((k) => {
    return JSON.stringify(req.body[k]) !== JSON.stringify((existing as Record<string, unknown>)[k]);
  });

  if (changedFields.length > 0) {
    const { id, createdAt, updatedAt, ...snapshotFields } = existing;
    await db.insert(templateVersionsTable).values({
      templateId: existing.id,
      version: existing.version,
      snapshot: snapshotFields,
      changedFields,
      changeReason: (req.body as Record<string, unknown>).changeReason as string || null,
    });
  }

  const newVersion = changedFields.length > 0 ? existing.version + 1 : existing.version;

  const [template] = await db
    .update(templatesTable)
    .set({ ...req.body, version: newVersion, updatedAt: new Date() })
    .where(eq(templatesTable.id, str(req.params.id)))
    .returning();

  res.json(UpdateTemplateResponse.parse(template));
});

router.delete("/templates/:id", requireRole("admin"), validateRequest({ params: DeleteTemplateParams }), async (req, res): Promise<void> => {
  const [template] = await db.delete(templatesTable).where(eq(templatesTable.id, str(req.params.id))).returning();
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.json(DeleteTemplateResponse.parse({ message: "Template deleted" }));
});

router.get("/templates/:id/versions", async (req, res): Promise<void> => {
  const id = str(req.params.id);
  const versions = await db.select().from(templateVersionsTable)
    .where(eq(templateVersionsTable.templateId, id))
    .orderBy(desc(templateVersionsTable.version));
  res.json(versions);
});

router.post("/templates/:id/rollback/:versionId", async (req, res): Promise<void> => {
  const id = str(req.params.id), versionId = str(req.params.versionId);

  const [current] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const [targetVersion] = await db.select().from(templateVersionsTable)
    .where(and(eq(templateVersionsTable.id, versionId), eq(templateVersionsTable.templateId, id)));
  if (!targetVersion) {
    res.status(404).json({ error: "Version not found" });
    return;
  }

  const { id: _curId, createdAt: _ca, updatedAt: _ua, ...snapshotFields } = current;
  await db.insert(templateVersionsTable).values({
    templateId: id,
    version: current.version,
    snapshot: snapshotFields,
    changedFields: ["rollback"],
    changeReason: `Rolled back to version ${targetVersion.version}`,
  });

  const snapshot = targetVersion.snapshot as Record<string, unknown>;
  const [restored] = await db.update(templatesTable)
    .set({
      ...snapshot,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(templatesTable.id, id))
    .returning();

  res.json(restored);
});

router.get("/templates/:id/stats", async (req, res): Promise<void> => {
  const id = str(req.params.id);

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const logs = await db.select().from(refinementLogsTable)
    .where(eq(refinementLogsTable.templateId, id));

  const totalLogs = logs.length;
  const approvals = logs.filter(l => l.editType === "approval").length;
  const rejections = logs.filter(l => l.editType === "rejection").length;
  const captionEdits = logs.filter(l => l.editType === "caption_edit").length;
  const headlineEdits = logs.filter(l => l.editType === "headline_edit").length;
  const imageRefinements = logs.filter(l => l.editType === "image_refinement").length;

  const totalDecisions = approvals + rejections;
  const approvalRate = totalDecisions > 0 ? approvals / totalDecisions : null;

  const refinementPrompts = logs
    .filter(l => l.editType === "image_refinement" && l.refinementPrompt)
    .map(l => l.refinementPrompt!);

  const promptFrequency: Record<string, number> = {};
  for (const p of refinementPrompts) {
    const normalized = p.toLowerCase().trim();
    promptFrequency[normalized] = (promptFrequency[normalized] || 0) + 1;
  }
  const topRefinementPrompts = Object.entries(promptFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([prompt, count]) => ({ prompt, count }));

  res.json({
    templateId: id,
    templateName: template.name,
    totalGenerations: template.totalGenerations,
    version: template.version,
    totalLogs,
    approvals,
    rejections,
    approvalRate,
    captionEdits,
    headlineEdits,
    imageRefinements,
    topRefinementPrompts,
  });
});

router.post("/templates/:id/analyze", async (req, res): Promise<void> => {
  const id = str(req.params.id);

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  try {
    const recommendation = await analyzeTemplate(id, template);
    res.json(recommendation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Analysis failed: ${message}` });
  }
});

router.get("/templates/:id/recommendations", async (req, res): Promise<void> => {
  const id = str(req.params.id);
  const recommendations = await db.select().from(templateRecommendationsTable)
    .where(eq(templateRecommendationsTable.templateId, id))
    .orderBy(desc(templateRecommendationsTable.createdAt));
  res.json(recommendations);
});

router.put("/templates/:id/recommendations/:recId", async (req, res): Promise<void> => {
  const id = str(req.params.id), recId = str(req.params.recId);
  const { action, reviewerNotes } = req.body;

  if (!action || !["apply", "dismiss"].includes(action)) {
    res.status(400).json({ error: "action must be 'apply' or 'dismiss'" });
    return;
  }

  const [rec] = await db.select().from(templateRecommendationsTable)
    .where(and(eq(templateRecommendationsTable.id, recId), eq(templateRecommendationsTable.templateId, id)));
  if (!rec) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }

  if (action === "dismiss") {
    const [updated] = await db.update(templateRecommendationsTable)
      .set({ status: "dismissed", reviewedAt: new Date(), reviewerNotes: reviewerNotes || null })
      .where(eq(templateRecommendationsTable.id, recId))
      .returning();
    res.json(updated);
    return;
  }

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, id));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const { id: _tId, createdAt: _ca, updatedAt: _ua, ...snapshotFields } = template;
  await db.insert(templateVersionsTable).values({
    templateId: id,
    version: template.version,
    snapshot: snapshotFields,
    changedFields: ["recommendation_applied"],
    changeReason: `Applied recommendation ${recId}`,
  });

  const recommendations = rec.recommendations as Array<{
    field: string;
    currentValue: unknown;
    recommendedValue: unknown;
    reasoning: string;
  }>;

  const ALLOWED_RECOMMENDATION_FIELDS = new Set([
    "imagenPromptAddition",
    "imagenNegativeAddition",
    "claudeCaptionInstruction",
    "claudeHeadlineInstruction",
    "layoutSpec",
    "description",
    "recommendedAssetTypes",
    "targetAspectRatios",
  ]);

  const updateFields: Record<string, unknown> = {};
  for (const r of recommendations) {
    if (r.field && r.recommendedValue !== undefined && ALLOWED_RECOMMENDATION_FIELDS.has(r.field)) {
      updateFields[r.field] = r.recommendedValue;
    }
  }

  if (Object.keys(updateFields).length > 0) {
    await db.update(templatesTable)
      .set({ ...updateFields, version: template.version + 1, updatedAt: new Date() })
      .where(eq(templatesTable.id, id));
  }

  const [updated] = await db.update(templateRecommendationsTable)
    .set({ status: "applied", reviewedAt: new Date(), reviewerNotes: reviewerNotes || null })
    .where(eq(templateRecommendationsTable.id, recId))
    .returning();

  res.json(updated);
});

export default router;

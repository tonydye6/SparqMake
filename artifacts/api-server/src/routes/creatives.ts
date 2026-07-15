import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, and, gte, sql } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, calendarEntriesTable } from "@workspace/db";
import {
  GetCreativesQueryParams,
  CreateCreativeBody,
  GetCreativeParams,
  GetCreativesResponse,
  GetCreativeResponse,
  UpdateCreativeParams,
  UpdateCreativeBody,
  UpdateCreativeResponse,
} from "@workspace/api-zod";
import { captureScreenshots, captureFromUpload, validateUrl } from "../services/screenshot.js";
import { validateRequest } from "../middleware/validate.js";
import { analyzeReference } from "../services/reference-analysis.js";
import { validateUploadedBuffer } from "../services/fileValidation.js";
import { requireRole } from "../middleware/auth.js";
import multer from "multer";
import { z } from "zod";

const CREATIVE_STATUSES = ["draft", "generating", "in_review", "approved", "rejected", "scheduled", "published", "archived"] as const;

const ReviewBody = z.object({
  status: z.enum(["approved", "rejected", "in_review"]),
  reviewComment: z.string().max(2000).optional(),
});

const router: IRouter = Router();
const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (PNG, JPEG, WebP, GIF) are allowed"));
    }
  },
});

router.get("/creatives", async (req, res): Promise<void> => {
  const query = GetCreativesQueryParams.safeParse(req.query);
  const conditions = [];

  if (query.success && query.data.brandId) {
    conditions.push(eq(creativesTable.brandId, query.data.brandId));
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const baseCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creativesTable)
    .where(baseCondition);
  const total = countResult?.count ?? 0;

  const results = baseCondition
    ? await db.select().from(creativesTable).where(baseCondition).orderBy(creativesTable.createdAt).limit(limit).offset(offset)
    : await db.select().from(creativesTable).orderBy(creativesTable.createdAt).limit(limit).offset(offset);

  res.json({ data: results, total, limit, offset });
});

router.get("/creatives/check-duplicate", async (req, res): Promise<void> => {
  const { templateId, primaryAssetId } = req.query as Record<string, string>;

  if (!templateId || !primaryAssetId) {
    res.json({ duplicate: false });
    return;
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db.select().from(creativesTable)
    .where(and(
      eq(creativesTable.templateId, templateId),
      gte(creativesTable.createdAt, thirtyDaysAgo),
    ))
    .orderBy(creativesTable.createdAt);

  const matches = results.filter(c => {
    const assets = (c.selectedAssets || []) as Array<{ assetId: string; role: string }>;
    return assets.some(a => a.assetId === primaryAssetId && a.role === "primary");
  });

  if (matches.length > 0) {
    const match = matches[matches.length - 1];
    res.json({
      duplicate: true,
      creativeId: match.id,
      creativeName: match.name,
      createdAt: match.createdAt,
    });
  } else {
    res.json({ duplicate: false });
  }
});

router.post("/creatives", validateRequest({ body: CreateCreativeBody }), async (req, res): Promise<void> => {
  const userId = (req as unknown as Record<string, unknown>).user
    ? ((req as unknown as Record<string, unknown>).user as { id: string }).id
    : "system";
  const [campaign] = await db.insert(creativesTable).values({ ...req.body, createdBy: userId }).returning();
  res.status(201).json(GetCreativeResponse.parse(campaign));
});

router.get("/creatives/:id", validateRequest({ params: GetCreativeParams }), async (req, res): Promise<void> => {
  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, str(req.params.id)));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  res.json(GetCreativeResponse.parse(campaign));
});

router.put("/creatives/:id", validateRequest({ params: UpdateCreativeParams, body: UpdateCreativeBody }), async (req, res): Promise<void> => {
  const { reviewedBy: _rb, reviewComment: _rc, reviewedAt: _ra, ...safeUpdates } = req.body as Record<string, unknown>;

  if (safeUpdates.status !== undefined && !CREATIVE_STATUSES.includes(safeUpdates.status as typeof CREATIVE_STATUSES[number])) {
    res.status(400).json({ error: `Invalid status. Allowed: ${CREATIVE_STATUSES.join(", ")}` });
    return;
  }

  if (safeUpdates.status === "approved" || safeUpdates.status === "rejected") {
    res.status(400).json({ error: "Use POST /creatives/:id/review to set approved/rejected status" });
    return;
  }

  const [campaign] = await db
    .update(creativesTable)
    .set({ ...safeUpdates, updatedAt: new Date() })
    .where(eq(creativesTable.id, str(req.params.id)))
    .returning();

  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  res.json(UpdateCreativeResponse.parse(campaign));
});

router.post("/creatives/:id/review", requireRole("editor"), validateRequest({ params: UpdateCreativeParams, body: ReviewBody }), async (req, res): Promise<void> => {
  const reviewer = (req.user as { id?: string } | undefined)?.id;
  if (!reviewer) {
    res.status(401).json({ error: "Reviewer identity required" });
    return;
  }

  const { status, reviewComment } = req.body as { status: string; reviewComment?: string };

  const [campaign] = await db
    .update(creativesTable)
    .set({
      status,
      reviewedBy: reviewer,
      reviewComment: reviewComment ?? null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    } as Record<string, unknown>)
    .where(eq(creativesTable.id, str(req.params.id)))
    .returning();

  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  res.json(UpdateCreativeResponse.parse(campaign));
});

router.post("/creatives/:id/schedule", async (req, res): Promise<void> => {
  const creativeId = str(req.params.id);
  const { scheduledAt, perPlatform, socialAccounts: socialAccountsMap } = req.body as {
    scheduledAt?: string;
    perPlatform?: Record<string, string>;
    socialAccounts?: Record<string, string>;
  };

  if (!scheduledAt && !perPlatform) {
    res.status(400).json({ error: "Either scheduledAt or perPlatform times required" });
    return;
  }

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  const variants = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.creativeId, creativeId));

  if (variants.length === 0) {
    res.status(400).json({ error: "No variants to schedule" });
    return;
  }

  const created = [];
  for (const variant of variants) {
    const time = perPlatform?.[variant.platform] || scheduledAt;
    if (!time) continue;

    const socialAccountId = socialAccountsMap?.[variant.platform] || null;

    const [entry] = await db.insert(calendarEntriesTable).values({
      creativeId,
      variantId: variant.id,
      platform: variant.platform,
      scheduledAt: new Date(time),
      socialAccountId,
      // Goal-aware posting: snapshot the creative's intent onto the entry.
      intent: campaign.intent || null,
    }).returning();
    created.push(entry);
  }

  await db.update(creativesTable)
    .set({ status: "scheduled", updatedAt: new Date() })
    .where(eq(creativesTable.id, creativeId));

  res.status(201).json({ entries: created, count: created.length });
});

router.post("/creatives/:id/analyze-url", async (req, res): Promise<void> => {
  const creativeId = str(req.params.id);
  const { url } = req.body as { url?: string };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  try {
    validateUrl(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid URL";
    res.status(400).json({ error: message });
    return;
  }

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  function sendEvent(event: string, data: Record<string, unknown>) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    sendEvent("progress", { phase: "capturing", message: "Capturing page screenshots..." });
    const screenshots = await captureScreenshots(url, creativeId);

    const screenshotUrls = screenshots.map(s => ({ url: s.url, viewport: s.viewport }));
    sendEvent("captured", {
      phase: "analyzing",
      message: "Analyzing reference design...",
      referenceScreenshots: screenshotUrls,
    });

    const analysis = await analyzeReference(
      screenshots.map(s => ({ buffer: s.buffer, mimeType: s.mimeType })),
    );

    await db.update(creativesTable)
      .set({
        referenceUrl: url,
        referenceAnalysis: analysis,
        referenceScreenshots: screenshotUrls,
        updatedAt: new Date(),
      })
      .where(eq(creativesTable.id, creativeId));

    sendEvent("complete", {
      phase: "done",
      referenceUrl: url,
      referenceAnalysis: analysis,
      referenceScreenshots: screenshotUrls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendEvent("error", { message: `Reference analysis failed: ${message}` });
  } finally {
    res.end();
  }
});

router.post("/creatives/:id/analyze-upload", upload.single("screenshot"), async (req, res): Promise<void> => {
  const creativeId = str(req.params.id);
  const file = req.file;

  if (!file) {
    res.status(400).json({ error: "Screenshot file is required" });
    return;
  }

  const validation = await validateUploadedBuffer(
    file.buffer,
    file.mimetype,
    file.originalname,
    ["image"],
  );
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  function sendEvent(event: string, data: Record<string, unknown>) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    sendEvent("progress", { phase: "capturing", message: "Processing uploaded screenshot..." });
    const screenshot = await captureFromUpload(file.buffer, creativeId, file.originalname);
    const screenshotUrls = [{ url: screenshot.url, viewport: screenshot.viewport }];

    sendEvent("captured", {
      phase: "analyzing",
      message: "Analyzing reference design...",
      referenceScreenshots: screenshotUrls,
    });

    const analysis = await analyzeReference([
      { buffer: screenshot.buffer, mimeType: screenshot.mimeType },
    ]);

    await db.update(creativesTable)
      .set({
        referenceUrl: null,
        referenceAnalysis: analysis,
        referenceScreenshots: screenshotUrls,
        updatedAt: new Date(),
      })
      .where(eq(creativesTable.id, creativeId));

    sendEvent("complete", {
      phase: "done",
      referenceUrl: null,
      referenceAnalysis: analysis,
      referenceScreenshots: screenshotUrls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendEvent("error", { message: `Reference analysis failed: ${message}` });
  } finally {
    res.end();
  }
});

router.delete("/creatives/:id/reference", async (req, res): Promise<void> => {
  const creativeId = str(req.params.id);

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  await db.update(creativesTable)
    .set({
      referenceUrl: null,
      referenceAnalysis: null,
      referenceScreenshots: null,
      updatedAt: new Date(),
    })
    .where(eq(creativesTable.id, creativeId));

  res.json({ cleared: true });
});

export default router;

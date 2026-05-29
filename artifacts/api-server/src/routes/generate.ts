import { str } from "../lib/http-params.js";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, costLogsTable, refinementLogsTable, templatesTable, appSettingsTable, assetsTable, assetPairingsTable, brandsTable, generationPacketLogsTable } from "@workspace/db";
import { sql, gte } from "drizzle-orm";
import { assembleContext, type SelectedAssetRef } from "../services/context-assembly.js";
import { generateCaptions } from "../services/claude.js";
import { generateAllImages, generateImage, PLATFORM_CONFIGS, type ReferenceImage } from "../services/imagen.js";
import { AI_MODELS, estimateClaudeCost, estimateImagenCost } from "../lib/ai-config.js";
import { compositeImage, type LayoutSpec } from "../services/compositing.js";
import { checkBrandReadiness } from "../lib/brand-readiness.js";
import { buildGenerationPacket } from "../services/packet-assembly.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";

interface AuthenticatedUser {
  id: string;
  [key: string]: unknown;
}

const CreativeVariantParams = z.object({
  id: z.string().min(1),
  variantId: z.string().min(1),
});

const UpdateCaptionBody = z.object({
  caption: z.string().min(1),
});

const UpdateHeadlineBody = z.object({
  headline: z.string().min(1),
});

const router: IRouter = Router();

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads", "generated");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveLocalFilePath(fileUrl: string): string | null {
  if (!fileUrl || fileUrl.startsWith("http")) return null;
  const resolved = path.resolve(process.cwd(), fileUrl.replace(/^\/api\/files\//, "uploads/"));
  const uploadsRoot = path.resolve(process.cwd(), "uploads");
  const prefix = uploadsRoot.endsWith(path.sep) ? uploadsRoot : uploadsRoot + path.sep;
  if (resolved !== uploadsRoot && !resolved.startsWith(prefix)) return null;
  return resolved;
}

async function fetchLogoBuffer(brandId: string): Promise<Buffer | null> {
  try {
    const logoAssets = await db.select().from(assetsTable)
      .where(and(
        eq(assetsTable.brandId, brandId),
        eq(assetsTable.assetClass, "compositing"),
        eq(assetsTable.type, "image"),
      ));

    const [logoAsset] = logoAssets
      .filter(a => a.generationRole === "compositing_logo" || (a.subType && a.subType.includes("logo")))
      .sort((a, b) => {
        if (a.subType?.includes("primary")) return -1;
        if (b.subType?.includes("primary")) return 1;
        return 0;
      });

    if (logoAsset?.fileUrl) {
      const logoPath = resolveLocalFilePath(logoAsset.fileUrl);
      if (logoPath && fs.existsSync(logoPath)) {
        return fs.readFileSync(logoPath);
      }
    }

    const [brand] = await db.select().from(brandsTable)
      .where(eq(brandsTable.id, brandId));
    if (brand?.logoFileUrl) {
      const logoPath = resolveLocalFilePath(brand.logoFileUrl);
      if (logoPath && fs.existsSync(logoPath)) {
        return fs.readFileSync(logoPath);
      }
    }
  } catch (err) {
    logger.error({ err, brandId }, "Failed to fetch logo buffer");
  }
  return null;
}

async function fetchBrandFontFamily(brandId: string): Promise<string | undefined> {
  try {
    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    const fonts = (brand?.brandFonts || []) as Array<{ name?: string; assetId?: string }>;
    if (fonts.length > 0 && fonts[0].name) {
      return fonts[0].name;
    }
  } catch (err) {
    logger.error({ err, brandId }, "Failed to fetch brand font");
  }
  return undefined;
}

async function buildReferenceImages(packet: Awaited<ReturnType<typeof buildGenerationPacket>>): Promise<ReferenceImage[]> {
  const refs: ReferenceImage[] = [];

  for (const entry of packet.generationAssets.slice(0, 3)) {
    if (!entry.asset.fileUrl) continue;

    try {
      let buffer: Buffer | null = null;
      const localPath = resolveLocalFilePath(entry.asset.fileUrl);
      if (localPath && fs.existsSync(localPath)) {
        buffer = fs.readFileSync(localPath);
      }

      if (buffer) {
        refs.push({
          imageBuffer: buffer,
          mimeType: entry.asset.mimeType || "image/png",
          role: entry.role === "style_reference" ? "style_reference" : "subject_reference",
          description: (entry.role !== "style_reference" && entry.asset.characterIdentityNote) ? entry.asset.characterIdentityNote : (entry.asset.description || entry.asset.name),
        });
      }
    } catch (err) {
      console.error(`Failed to load reference image for asset ${entry.asset.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return refs;
}

router.post("/creatives/:id/generate", generationLimiter, async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id);

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  if (!campaign.templateId) {
    res.status(400).json({ error: "Creative must have a template selected" });
    return;
  }

  // --- Brand safety gates (must run before SSE writeHead) ---
  const selectedAssets = (campaign.selectedAssets || []) as SelectedAssetRef[];
  const selectedAssetIds = selectedAssets.map(a => a.assetId);

  if (selectedAssetIds.length > 0) {
    const assets = await db.select({ id: assetsTable.id, status: assetsTable.status })
      .from(assetsTable)
      .where(inArray(assetsTable.id, selectedAssetIds));

    const unapproved = assets.filter(a => a.status !== "approved").map(a => a.id);
    const missing = selectedAssetIds.filter(id => !assets.find(a => a.id === id));

    if (unapproved.length > 0 || missing.length > 0) {
      res.status(400).json({
        error: "UNAPPROVED_ASSETS",
        message: "All selected assets must be approved before generation",
        unapprovedAssets: [...unapproved, ...missing],
      });
      return;
    }
  }

  const readiness = await checkBrandReadiness(campaign.brandId);
  if (!readiness.ready) {
    res.status(400).json({
      error: "BRAND_NOT_READY",
      message: "Brand setup is incomplete",
      ...readiness,
    });
    return;
  }

  const [thresholdRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "dailyCostThreshold"));
  const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  let reservationId: string | null = null;

  if (budgetThreshold !== null && !isNaN(budgetThreshold) && budgetThreshold > 0) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const estimatedGenerationCost = estimateClaudeCost() + estimateImagenCost(Object.keys(PLATFORM_CONFIGS).length);
    reservationId = crypto.randomUUID();

    const budgetCheckResult = await db.transaction(async (tx) => {
      const BUDGET_LOCK_KEY = 100001;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
      const [todayResult] = await tx.select({
        totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
      }).from(costLogsTable).where(gte(costLogsTable.createdAt, todayStart));
      const currentSpend = Number(todayResult?.totalCost || 0);

      if (currentSpend + estimatedGenerationCost > budgetThreshold) {
        return { exceeded: true as const, todaySpend: currentSpend };
      }

      await tx.insert(costLogsTable).values({
        id: reservationId!,
        creativeId,
        service: "system",
        operation: "budget_reservation",
        model: null,
        costUsd: estimatedGenerationCost,
      });
      return { exceeded: false as const, todaySpend: currentSpend };
    });

    if (budgetCheckResult.exceeded) {
      res.status(429).json({
        error: "Daily budget exceeded",
        todaySpend: budgetCheckResult.todaySpend,
        threshold: budgetThreshold,
        message: `Today's spend ($${budgetCheckResult.todaySpend.toFixed(2)}) has reached the daily budget limit ($${budgetThreshold.toFixed(2)}). Increase the limit in Cost Dashboard settings or wait until tomorrow.`,
      });
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const SSE_TIMEOUT_MS = 5 * 60 * 1000;
  let clientDisconnected = false;
  const sseTimeout = setTimeout(() => {
    if (!clientDisconnected) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Generation timed out after 5 minutes" })}\n\n`);
    }
    clientDisconnected = true;
    res.end();
  }, SSE_TIMEOUT_MS);
  req.on("close", () => { clientDisconnected = true; clearTimeout(sseTimeout); });

  function sendEvent(event: string, data: Record<string, unknown>) {
    if (clientDisconnected) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  let tmpDir: string | null = null;
  try {
    await db.update(creativesTable)
      .set({ status: "generating", updatedAt: new Date() })
      .where(eq(creativesTable.id, creativeId));
    sendEvent("status", { status: "generating", message: "Starting generation..." });

    sendEvent("progress", { step: "packet", message: "Building generation packet..." });

    let packet: Awaited<ReturnType<typeof buildGenerationPacket>> | null = null;
    let referenceImages: ReferenceImage[] = [];

    if (selectedAssetIds.length > 0) {
      packet = await buildGenerationPacket({
        creativeId,
        brandId: campaign.brandId,
        templateId: campaign.templateId,
        platform: "all",
        selectedAssetIds,
      });
      sendEvent("progress", {
        step: "packet",
        message: `Packet assembled: ${packet.generationAssets.length} generation, ${packet.compositingAssets.length} compositing`,
        done: true,
        reasoning: packet.reasoning.strategy,
      });

      referenceImages = await buildReferenceImages(packet);
      if (referenceImages.length > 0) {
        sendEvent("progress", { step: "references", message: `${referenceImages.length} reference image(s) loaded for AI generation` });
      }
    } else {
      sendEvent("progress", { step: "packet", message: "No assets selected, using text-only generation", done: true });
    }

    sendEvent("progress", { step: "context", message: "Assembling context from brand DNA..." });
    const ctx = await assembleContext({
      brandId: campaign.brandId,
      templateId: campaign.templateId,
      selectedAssets,
      selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
      briefText: campaign.briefText || undefined,
      referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
      generationPacket: packet,
    });
    sendEvent("progress", { step: "context", message: "Context assembled", done: true });

    const allPlatforms = Object.keys(PLATFORM_CONFIGS);
    const requestedPlatforms = Array.isArray(req.body?.platforms) ? req.body.platforms.filter((p: string) => allPlatforms.includes(p)) : [];
    const platforms = requestedPlatforms.length > 0 ? requestedPlatforms : allPlatforms;

    sendEvent("progress", { step: "captions", message: "Generating captions with Claude..." });
    const captionsPromise = generateCaptions(ctx);

    sendEvent("progress", { step: "images", message: "Generating images for all platforms..." });
    const imagesPromise = generateAllImages(ctx, platforms, (platform, status, error) => {
      sendEvent("image_progress", { platform, status, error });
    }, referenceImages);

    const captions = await captionsPromise;
    sendEvent("progress", { step: "captions", message: "Captions generated", done: true });

    for (const platform of platforms) {
      const platformKey = platform as keyof typeof captions;
      const captionData = captions[platformKey] || { caption: "", headline: "" };
      const config = PLATFORM_CONFIGS[platform];
      sendEvent("caption_ready", {
        platform,
        aspectRatio: config ? `${config.width}:${config.height}` : "1:1",
        caption: captionData.caption,
        headline: captionData.headline,
      });
    }

    const images = await imagesPromise;
    sendEvent("progress", { step: "images", message: `${images.length} images generated`, done: true });

    sendEvent("progress", { step: "compositing", message: "Compositing images with overlays..." });
    const layoutSpec = ctx.template.layoutSpec as Record<string, unknown> | null;

    const [logoBuffer, brandFontFamily] = await Promise.all([
      fetchLogoBuffer(campaign.brandId),
      fetchBrandFontFamily(campaign.brandId),
    ]);
    if (logoBuffer) {
      sendEvent("progress", { step: "compositing", message: "Brand logo loaded for compositing" });
    }

    ensureDir(UPLOADS_DIR);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sparqmake-gen-${creativeId}-`));
    const stagedFiles: Array<{ tmpPath: string; finalPath: string }> = [];

    const variantRecords: (typeof creativeVariantsTable.$inferInsert)[] = [];

    for (const img of images) {
      const platformKey = img.platform as keyof typeof captions;
      const captionData = captions[platformKey] || { caption: "", headline: "" };
      const config = PLATFORM_CONFIGS[img.platform];

      const rawFilename = `${creativeId}_${img.platform}_raw.png`;
      const rawTmpPath = path.join(tmpDir, rawFilename);
      fs.writeFileSync(rawTmpPath, img.imageBuffer);
      stagedFiles.push({ tmpPath: rawTmpPath, finalPath: path.join(UPLOADS_DIR, rawFilename) });

      let compositedBuffer: Buffer;
      let compositingFailed = false;
      try {
        const result = await compositeImage({
          rawImageBuffer: img.imageBuffer,
          layoutSpec: layoutSpec as LayoutSpec | null,
          headlineText: captionData.headline || null,
          logoBuffer,
          width: config.width,
          height: config.height,
          fontFamily: brandFontFamily,
        });
        compositedBuffer = result.buffer;
        if (result.warnings.length > 0) {
          sendEvent("compositing_warning", {
            platform: img.platform,
            warnings: result.warnings,
          });
        }
      } catch (err) {
        console.error(`Compositing failed for ${img.platform}, using raw image:`, err instanceof Error ? err.message : err);
        compositedBuffer = img.imageBuffer;
        compositingFailed = true;
        sendEvent("compositing_warning", {
          platform: img.platform,
          message: `Compositing failed for ${img.platform}: ${err instanceof Error ? err.message : "unknown error"}. Using raw image as fallback.`,
        });
      }

      if (packet && referenceImages.length > 0) {
        try {
          await db.insert(generationPacketLogsTable).values({
            creativeId,
            platform: img.platform,
            templateId: campaign.templateId,
            packetType: "reference_guided",
            primaryAssetId: packet.generationAssets[0]?.asset.id || null,
            supportingAssetIds: packet.generationAssets.slice(1).map(a => a.asset.id),
            styleAssetIds: packet.generationAssets.filter(a => a.role === "style_reference").map(a => a.asset.id),
            contextAssetIds: packet.contextAssets.map(a => a.asset.id),
            compositingAssetIds: packet.compositingAssets.map(a => a.asset.id),
            excludedAssetIds: packet.excludedAssets.map(a => a.asset.id),
            packetReasoning: { ...packet.reasoning, platform: img.platform, aspectRatio: img.aspectRatio },
          });
        } catch (err) {
          console.error(`Failed to log per-platform packet for ${img.platform}:`, err instanceof Error ? err.message : err);
        }
      }

      const compFilename = `${creativeId}_${img.platform}_composited.png`;
      const compTmpPath = path.join(tmpDir, compFilename);
      fs.writeFileSync(compTmpPath, compositedBuffer);
      stagedFiles.push({ tmpPath: compTmpPath, finalPath: path.join(UPLOADS_DIR, compFilename) });

      variantRecords.push({
        creativeId,
        platform: img.platform,
        aspectRatio: img.aspectRatio,
        rawImageUrl: `/api/files/generated/${rawFilename}`,
        compositedImageUrl: `/api/files/generated/${compFilename}`,
        caption: captionData.caption,
        originalCaption: captionData.caption,
        headlineText: captionData.headline,
        originalHeadline: captionData.headline,
        status: "generated",
        compositingFailed: compositingFailed ? `Compositing failed for ${img.platform}. Using raw image as fallback.` : null,
      });

      sendEvent("image_ready", {
        platform: img.platform,
        aspectRatio: img.aspectRatio,
        rawImageUrl: `/api/files/generated/${rawFilename}`,
        compositedImageUrl: `/api/files/generated/${compFilename}`,
      });
    }

    sendEvent("progress", { step: "compositing", message: "Compositing complete", done: true });

    sendEvent("progress", { step: "saving", message: "Saving variants to database..." });

    const totalCost = estimateClaudeCost() + estimateImagenCost(images.length);

    const insertedVariants = await db.transaction(async (tx) => {
      const existingVariants = await tx.select().from(creativeVariantsTable)
        .where(eq(creativeVariantsTable.creativeId, creativeId));

      if (existingVariants.length > 0) {
        await tx.delete(creativeVariantsTable)
          .where(eq(creativeVariantsTable.creativeId, creativeId));
      }

      const inserted = [];
      for (const record of variantRecords) {
        const [row] = await tx.insert(creativeVariantsTable).values(record).returning();
        inserted.push(row);
      }

      await tx.update(creativesTable)
        .set({ status: "draft", estimatedCost: totalCost, updatedAt: new Date() })
        .where(eq(creativesTable.id, creativeId));

      if (campaign.templateId) {
        await tx.update(templatesTable)
          .set({ totalGenerations: sql`COALESCE(${templatesTable.totalGenerations}, 0) + 1` })
          .where(eq(templatesTable.id, campaign.templateId));
      }

      if (reservationId) {
        await tx.delete(costLogsTable)
          .where(eq(costLogsTable.id, reservationId));
      }

      await tx.insert(costLogsTable).values({
        creativeId,
        service: "anthropic",
        operation: "caption_generation",
        model: AI_MODELS.CLAUDE_SONNET,
        costUsd: estimateClaudeCost(),
      });
      await tx.insert(costLogsTable).values({
        creativeId,
        service: "gemini",
        operation: "image_generation",
        model: AI_MODELS.GEMINI_FLASH_IMAGE,
        costUsd: estimateImagenCost(images.length),
      });

      return inserted;
    });

    const failedCopies: string[] = [];
    for (const staged of stagedFiles) {
      try {
        fs.copyFileSync(staged.tmpPath, staged.finalPath);
      } catch (err) {
        console.error(`Failed to copy staged file ${staged.tmpPath}:`, err instanceof Error ? err.message : err);
        failedCopies.push(staged.tmpPath);
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    if (failedCopies.length > 0) {
      sendEvent("compositing_warning", { message: `${failedCopies.length} file(s) could not be saved to disk. Some variants may show broken images.` });
      for (const v of insertedVariants) {
        await db.update(creativeVariantsTable)
          .set({ compositingFailed: "File promotion failed. Please regenerate this variant." })
          .where(eq(creativeVariantsTable.id, v.id));
      }
    }

    if (packet && packet.generationAssets.length >= 2) {
      try {
        const primary = packet.generationAssets[0];
        for (let i = 1; i < packet.generationAssets.length; i++) {
          const secondary = packet.generationAssets[i];
          await db.insert(assetPairingsTable).values({
            creativeId,
            primaryAssetId: primary.asset.id,
            secondaryAssetId: secondary.asset.id,
            templateId: campaign.templateId,
            platform: "all",
            usageCount: 1,
            firstPassApproved: null,
            finalStatus: "generated",
          });
        }
      } catch (err) {
        console.error("Failed to log asset pairings:", err instanceof Error ? err.message : err);
      }
    }

    sendEvent("complete", {
      message: "Generation complete!",
      variantCount: insertedVariants.length,
      estimatedCost: totalCost,
      variants: insertedVariants,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendEvent("error", { message: `Generation failed: ${message}` });
    await db.update(creativesTable)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(creativesTable.id, creativeId));
    if (reservationId) {
      try {
        await db.delete(costLogsTable)
          .where(eq(costLogsTable.id, reservationId));
      } catch {}
    }
    try {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  } finally {
    clearTimeout(sseTimeout);
    res.end();
  }
});

router.put("/creatives/:id/variants/:variantId/caption", validateRequest({ params: CreativeVariantParams, body: UpdateCaptionBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const { caption } = req.body;

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  const [updated] = await db.update(creativeVariantsTable)
    .set({ caption, updatedAt: new Date() })
    .where(eq(creativeVariantsTable.id, variantId))
    .returning();

  if (variant.originalCaption && caption !== variant.originalCaption) {
    const [camp] = await db.select({ templateId: creativesTable.templateId }).from(creativesTable).where(eq(creativesTable.id, creativeId));
    if (camp?.templateId) {
      await db.insert(refinementLogsTable).values({
        creativeId,
        templateId: camp.templateId,
        editType: "caption_edit",
        platform: variant.platform,
        aspectRatio: variant.aspectRatio,
        originalValue: variant.originalCaption,
        newValue: caption,
        userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || "system",
      });
    }
  }

  res.json(updated);
});

router.put("/creatives/:id/variants/:variantId/headline", validateRequest({ params: CreativeVariantParams, body: UpdateHeadlineBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const { headline } = req.body;

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign || !campaign.templateId) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  const config = PLATFORM_CONFIGS[variant.platform];
  if (!config) {
    res.status(400).json({ error: "Unknown platform" });
    return;
  }

  let compositedUrl = variant.compositedImageUrl;
  if (variant.rawImageUrl) {
    try {
      const rawFilename = variant.rawImageUrl.replace("/api/files/generated/", "");
      const rawPath = path.join(UPLOADS_DIR, rawFilename);
      if (fs.existsSync(rawPath)) {
        const rawBuffer = fs.readFileSync(rawPath);
        const ctx = await assembleContext({
          brandId: campaign.brandId,
          templateId: campaign.templateId,
          selectedAssets: [],
        });

        const [logoBuffer, fontFamily] = await Promise.all([
          fetchLogoBuffer(campaign.brandId),
          fetchBrandFontFamily(campaign.brandId),
        ]);

        const newResult = await compositeImage({
          rawImageBuffer: rawBuffer,
          layoutSpec: ctx.template.layoutSpec as LayoutSpec | null,
          headlineText: headline,
          logoBuffer,
          width: config.width,
          height: config.height,
          fontFamily,
        });

        const compFilename = `${creativeId}_${variant.platform}_composited.png`;
        const compPath = path.join(UPLOADS_DIR, compFilename);
        fs.writeFileSync(compPath, newResult.buffer);
        compositedUrl = `/api/files/generated/${compFilename}`;
      }
    } catch (err) {
      console.error("Failed to recomposite for headline update:", err instanceof Error ? err.message : err);
    }
  }

  const [updated] = await db.update(creativeVariantsTable)
    .set({ headlineText: headline, compositedImageUrl: compositedUrl, updatedAt: new Date() })
    .where(eq(creativeVariantsTable.id, variantId))
    .returning();

  if (variant.originalHeadline && headline !== variant.originalHeadline) {
    await db.insert(refinementLogsTable).values({
      creativeId,
      templateId: campaign.templateId,
      editType: "headline_edit",
      platform: variant.platform,
      aspectRatio: variant.aspectRatio,
      originalValue: variant.originalHeadline,
      newValue: headline,
      userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || "system",
    });
  }

  res.json(updated);
});

router.post("/creatives/:id/variants/:variantId/regenerate", generationLimiter, async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const { instruction } = req.body || {};

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }
  if (!campaign.templateId) {
    res.status(400).json({ error: "Creative must have a template" });
    return;
  }

  const [variant] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  const config = PLATFORM_CONFIGS[variant.platform];
  if (!config) {
    res.status(400).json({ error: "Unknown platform" });
    return;
  }

  const [thresholdRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "dailyCostThreshold"));
  const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  let reservationId: string | null = null;

  if (budgetThreshold !== null && !isNaN(budgetThreshold) && budgetThreshold > 0) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const estimatedGenerationCost = estimateImagenCost(1);
    reservationId = crypto.randomUUID();

    const budgetCheckResult = await db.transaction(async (tx) => {
      const BUDGET_LOCK_KEY = 100001;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
      const [todayResult] = await tx.select({
        totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
      }).from(costLogsTable).where(gte(costLogsTable.createdAt, todayStart));
      const currentSpend = Number(todayResult?.totalCost || 0);

      if (currentSpend + estimatedGenerationCost > budgetThreshold) {
        return { exceeded: true as const, todaySpend: currentSpend };
      }

      await tx.insert(costLogsTable).values({
        id: reservationId!,
        creativeId,
        service: "system",
        operation: "budget_reservation",
        model: null,
        costUsd: estimatedGenerationCost,
      });
      return { exceeded: false as const, todaySpend: currentSpend };
    });

    if (budgetCheckResult.exceeded) {
      res.status(429).json({
        error: "Daily budget exceeded",
        todaySpend: budgetCheckResult.todaySpend,
        threshold: budgetThreshold,
        message: `Today's spend ($${budgetCheckResult.todaySpend.toFixed(2)}) has reached the daily budget limit ($${budgetThreshold.toFixed(2)}). Increase the limit in Cost Dashboard settings or wait until tomorrow.`,
      });
      return;
    }
  }

  let regenTmpDir: string | null = null;
  try {
    const selectedAssets = (campaign.selectedAssets || []) as import("../services/context-assembly.js").SelectedAssetRef[];
    const selectedAssetIds = selectedAssets.map(a => a.assetId);

    let packet: Awaited<ReturnType<typeof buildGenerationPacket>> | null = null;
    let referenceImages: ReferenceImage[] = [];

    if (selectedAssetIds.length > 0) {
      packet = await buildGenerationPacket({
        creativeId,
        brandId: campaign.brandId,
        templateId: campaign.templateId,
        platform: variant.platform,
        selectedAssetIds,
      });
      referenceImages = await buildReferenceImages(packet);
    }

    const ctx = await assembleContext({
      brandId: campaign.brandId,
      templateId: campaign.templateId,
      selectedAssets,
      selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
      briefText: instruction
        ? `${campaign.briefText || ""}\n\nADDITIONAL REFINEMENT: ${instruction}`
        : campaign.briefText || undefined,
      referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
      generationPacket: packet,
    });

    const imgResult = await generateImage(ctx, variant.platform, referenceImages);

    ensureDir(UPLOADS_DIR);

    regenTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparq-regen-"));
    const ts = Date.now();
    const rawFilename = `${creativeId}_${variant.platform}_${ts}_raw.png`;
    const rawTmpPath = path.join(regenTmpDir, rawFilename);
    fs.writeFileSync(rawTmpPath, imgResult.imageBuffer);

    const layoutSpec = ctx.template.layoutSpec as Record<string, unknown> | null;
    const [logoBuffer, brandFontFamily] = await Promise.all([
      fetchLogoBuffer(campaign.brandId),
      fetchBrandFontFamily(campaign.brandId),
    ]);

    let compositedBuffer: Buffer;
    let compositingFailed = false;
    try {
      const result = await compositeImage({
        rawImageBuffer: imgResult.imageBuffer,
        layoutSpec: layoutSpec as LayoutSpec | null,
        headlineText: variant.headlineText || null,
        logoBuffer,
        width: config.width,
        height: config.height,
        fontFamily: brandFontFamily,
      });
      compositedBuffer = result.buffer;
    } catch (err) {
      console.error(`Compositing failed during regeneration for ${variant.platform}, using raw image:`, err instanceof Error ? err.message : err);
      compositedBuffer = imgResult.imageBuffer;
      compositingFailed = true;
    }

    const compFilename = `${creativeId}_${variant.platform}_${ts}_composited.png`;
    const compTmpPath = path.join(regenTmpDir, compFilename);
    fs.writeFileSync(compTmpPath, compositedBuffer);

    const rawFinalPath = path.join(UPLOADS_DIR, rawFilename);
    const compFinalPath = path.join(UPLOADS_DIR, compFilename);

    try {
      fs.copyFileSync(rawTmpPath, rawFinalPath);
      fs.copyFileSync(compTmpPath, compFinalPath);
    } catch (copyErr) {
      try { fs.unlinkSync(rawFinalPath); } catch {}
      try { fs.unlinkSync(compFinalPath); } catch {}
      throw new Error("Failed to save generated files. Please try again.");
    }

    let updated;
    try {
      [updated] = await db.transaction(async (tx) => {
        const [result] = await tx.update(creativeVariantsTable)
          .set({
            rawImageUrl: `/api/files/generated/${rawFilename}`,
            compositedImageUrl: `/api/files/generated/${compFilename}`,
            compositingFailed: compositingFailed ? `Compositing failed during regeneration for ${variant.platform}. Using raw image as fallback.` : null,
            updatedAt: new Date(),
          })
          .where(eq(creativeVariantsTable.id, variantId))
          .returning();

        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }

        const cost = estimateImagenCost(1);
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "gemini",
          operation: "single_variant_regeneration",
          model: AI_MODELS.GEMINI_FLASH_IMAGE,
          costUsd: cost,
        });

        if (campaign.templateId) {
          await tx.insert(refinementLogsTable).values({
            creativeId,
            templateId: campaign.templateId,
            editType: "image_refinement",
            platform: variant.platform,
            aspectRatio: variant.aspectRatio,
            refinementPrompt: instruction || null,
            userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || "system",
          });
        }

        return [result];
      });
    } catch (dbErr) {
      try { fs.unlinkSync(rawFinalPath); } catch {}
      try { fs.unlinkSync(compFinalPath); } catch {}
      throw dbErr;
    }
    fs.rmSync(regenTmpDir, { recursive: true, force: true });
    regenTmpDir = null;

    res.json(updated);
  } catch (error) {
    if (regenTmpDir) {
      try { fs.rmSync(regenTmpDir, { recursive: true, force: true }); } catch {}
    }
    if (reservationId) {
      try {
        await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
      } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Regeneration failed: ${message}` });
  }
});

export default router;

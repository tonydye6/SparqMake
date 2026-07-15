import { str } from "../lib/http-params.js";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, costLogsTable, refinementLogsTable, templatesTable, appSettingsTable, assetsTable, assetPairingsTable, brandsTable, generationPacketLogsTable } from "@workspace/db";
import { sql, gte } from "drizzle-orm";
import { assembleContext, resolveStyleProfile, type SelectedAssetRef } from "../services/context-assembly.js";
import { generateCaptions } from "../services/claude.js";
import { generateAllImages, generateImage, outpaintImage, PLATFORM_CONFIGS, type ReferenceImage, type VaryMode } from "../services/imagen.js";
import { AI_MODELS, estimateClaudeCost, estimateGeminiTextCost, estimateImagenCost } from "../lib/ai-config.js";
import { compositeImage, reframeImage, imageDimensions, type LayoutSpec, type BrandColorGuidance } from "../services/compositing.js";
import { renderHeadlineIntoImage, HeadlineRenderError, MAX_HEADLINE_RENDER_ATTEMPTS } from "../services/headline-render.js";
import { detectSubject, predictClip, type SubjectBox } from "../services/focal-point.js";
import { checkBrandReadiness } from "../lib/brand-readiness.js";
import { buildGenerationPacket } from "../services/packet-assembly.js";
import { recordAssetUsage, packetAssetIds } from "../services/asset-usage.js";
import { writeBuffer, writeFromFile, readBuffer, deleteObject, resolveUrl } from "../services/storage.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";
import { recordTasteSignal } from "../services/taste-signals.js";

interface AuthenticatedUser {
  id: string;
  [key: string]: unknown;
}

const CreativeParams = z.object({
  id: z.string().min(1),
});

const CreativeVariantParams = z.object({
  id: z.string().min(1),
  variantId: z.string().min(1),
});

const UpdateCaptionBody = z.object({
  caption: z.string().min(1),
});

const UpdateHeadlineBody = z.object({
  headline: z.string().min(1),
  // "instant" — free design-aware SVG overlay recomposite (default).
  // "render"  — the image model paints the headline into the scene as
  //             art-directed typography (verified by OCR, retried, falls back
  //             to the overlay when every attempt fails).
  mode: z.enum(["instant", "render"]).default("instant"),
});

const RefocusBody = z.object({
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
});

const router: IRouter = Router();

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads", "generated");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Read a stored file's bytes by its public "/api/files/..." URL (any backend). */
async function readFileByUrl(fileUrl: string | null | undefined): Promise<Buffer | null> {
  const loc = resolveUrl(fileUrl);
  return loc ? readBuffer(loc) : null;
}

/** Soft-delete a generated artifact by filename (used to clean up after failures). */
async function deleteGenerated(filename: string): Promise<void> {
  await deleteObject({ namespace: "generated", filename });
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
      const buf = await readFileByUrl(logoAsset.fileUrl);
      if (buf) return buf;
    }

    const [brand] = await db.select().from(brandsTable)
      .where(eq(brandsTable.id, brandId));
    if (brand?.logoFileUrl) {
      const buf = await readFileByUrl(brand.logoFileUrl);
      if (buf) return buf;
    }
  } catch (err) {
    logger.error({ err, brandId }, "Failed to fetch logo buffer");
  }
  return null;
}

// Brand design guidance for typography work: font family, palette, name.
// Best-effort — a missing brand just yields undefined fields.
async function fetchBrandDesign(brandId: string): Promise<{
  fontFamily?: string;
  colors: BrandColorGuidance;
  brandName?: string;
}> {
  try {
    const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    const fonts = (brand?.brandFonts || []) as Array<{ name?: string }>;
    return {
      fontFamily: fonts.length > 0 && fonts[0].name ? fonts[0].name : undefined,
      colors: {
        primary: brand?.colorPrimary ?? null,
        secondary: brand?.colorSecondary ?? null,
        accent: brand?.colorAccent ?? null,
      },
      brandName: brand?.name,
    };
  } catch (err) {
    logger.error({ err, brandId }, "Failed to fetch brand design guidance");
    return { colors: {} };
  }
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
      const buffer: Buffer | null = await readFileByUrl(entry.asset.fileUrl);

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

    const styleProfile = await resolveStyleProfile(campaign.brandId, campaign.styleProfileId);
    const styleRefIds = styleProfile?.referenceAssetIds || [];
    if (styleProfile) {
      sendEvent("progress", { step: "packet", message: `Applying design style "${styleProfile.name}"` });
    }

    if (selectedAssetIds.length > 0 || styleRefIds.length > 0) {
      packet = await buildGenerationPacket({
        creativeId,
        brandId: campaign.brandId,
        templateId: campaign.templateId,
        platform: "all",
        selectedAssetIds,
        priorityStyleAssetIds: styleRefIds,
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
      intent: campaign.intent || undefined,
      generationPacket: packet,
      styleProfile,
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

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `sparqmake-gen-${creativeId}-`));
    const stagedFiles: Array<{ tmpPath: string; filename: string }> = [];

    const variantRecords: (typeof creativeVariantsTable.$inferInsert)[] = [];

    for (const img of images) {
      const platformKey = img.platform as keyof typeof captions;
      const captionData = captions[platformKey] || { caption: "", headline: "" };
      const config = PLATFORM_CONFIGS[img.platform];

      const rawFilename = `${creativeId}_${img.platform}_raw.png`;
      const rawTmpPath = path.join(tmpDir, rawFilename);
      fs.writeFileSync(rawTmpPath, img.imageBuffer);
      stagedFiles.push({ tmpPath: rawTmpPath, filename: rawFilename });

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
      stagedFiles.push({ tmpPath: compTmpPath, filename: compFilename });

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
        await writeFromFile("generated", staged.filename, staged.tmpPath);
      } catch (err) {
        console.error(`Failed to promote staged file ${staged.tmpPath}:`, err instanceof Error ? err.message : err);
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

    await recordAssetUsage(packetAssetIds(packet));

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
    const [camp] = await db.select({ templateId: creativesTable.templateId, brandId: creativesTable.brandId }).from(creativesTable).where(eq(creativesTable.id, creativeId));
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
    if (camp && variant.caption !== caption) {
      // Taste learning: an edit away from the AI caption reveals wording taste.
      await recordTasteSignal({
        brandId: camp.brandId,
        creativeId,
        variantId,
        signalType: "caption_edit",
        payload: { platform: variant.platform, before: variant.caption, after: caption },
        userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || null,
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

  const mode = (req.body.mode as "instant" | "render" | undefined) ?? "instant";

  // Render mode is a billable path (image call + OCR verify per attempt):
  // reserve worst-case headroom up front, settle the real spend after.
  let reservationId: string | null = null;
  if (mode === "render" && variant.rawImageUrl) {
    const worstCase = estimateImagenCost(MAX_HEADLINE_RENDER_ATTEMPTS) + estimateGeminiTextCost() * MAX_HEADLINE_RENDER_ATTEMPTS;
    const budget = await reserveBudget(creativeId, worstCase);
    if (!budget.ok) {
      res.status(429).json(budgetExceededBody(budget.todaySpend, budget.threshold));
      return;
    }
    reservationId = budget.reservationId;
  }

  let compositedUrl = variant.compositedImageUrl;
  let headlineRenderMode = variant.headlineRenderMode;
  let renderFallback: string | null = null;
  let renderAttempts = 0;
  if (variant.rawImageUrl) {
    try {
      const rawBuffer = await readFileByUrl(variant.rawImageUrl);
      if (rawBuffer) {
        const ctx = await assembleContext({
          brandId: campaign.brandId,
          templateId: campaign.templateId,
          selectedAssets: [],
        });

        const [logoBuffer, design] = await Promise.all([
          fetchLogoBuffer(campaign.brandId),
          fetchBrandDesign(campaign.brandId),
        ]);

        let baseBuffer = rawBuffer;
        let overlayHeadline: string | null = headline;
        if (mode === "render") {
          try {
            const rendered = await renderHeadlineIntoImage(
              rawBuffer,
              "image/png",
              headline,
              { ...design.colors, fontFamily: design.fontFamily, brandName: design.brandName,
                colorPrimary: design.colors.primary, colorSecondary: design.colors.secondary, colorAccent: design.colors.accent },
              variant.aspectRatio || config.aspectRatio,
              (attempt) => { renderAttempts = attempt; },
            );
            baseBuffer = rendered.buffer;
            overlayHeadline = null; // typography lives in the image now
            headlineRenderMode = "rendered";
          } catch (renderErr) {
            if (renderErr instanceof HeadlineRenderError) {
              renderFallback = renderErr.message + " Applied the design-aware overlay instead.";
              headlineRenderMode = "overlay";
            } else {
              throw renderErr;
            }
          }
        } else {
          headlineRenderMode = "overlay";
        }

        const newResult = await compositeImage({
          rawImageBuffer: baseBuffer,
          layoutSpec: ctx.template.layoutSpec as LayoutSpec | null,
          headlineText: overlayHeadline,
          logoBuffer,
          width: config.width,
          height: config.height,
          fontFamily: design.fontFamily,
          brandColors: design.colors,
          aspectRatio: variant.aspectRatio || config.aspectRatio,
        });

        // Token-named file so clients never see a stale cached composite.
        const compFilename = `${creativeId}_${variant.platform}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_composited.png`;
        await writeBuffer("generated", compFilename, newResult.buffer);
        compositedUrl = `/api/files/generated/${compFilename}`;
      }
    } catch (err) {
      if (reservationId) {
        try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
        reservationId = null;
      }
      if (mode === "render") {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `Headline render failed: ${message}` });
        return;
      }
      console.error("Failed to recomposite for headline update:", err instanceof Error ? err.message : err);
    }
  }

  // Settle the reservation against the real spend (attempts actually made).
  if (reservationId) {
    try {
      await db.transaction(async (tx) => {
        await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId!));
        if (renderAttempts > 0) {
          await tx.insert(costLogsTable).values({
            creativeId,
            service: "gemini",
            operation: "headline_render",
            model: AI_MODELS.GEMINI_FLASH_IMAGE,
            costUsd: estimateImagenCost(renderAttempts) + estimateGeminiTextCost() * renderAttempts,
          });
        }
      });
    } catch (costErr) {
      logger.error({ err: costErr, creativeId }, "Failed to settle headline render cost");
    }
  }

  const [updated] = await db.update(creativeVariantsTable)
    .set({ headlineText: headline, compositedImageUrl: compositedUrl, headlineRenderMode, updatedAt: new Date() })
    .where(eq(creativeVariantsTable.id, variantId))
    .returning();

  if (variant.headlineText && headline !== variant.headlineText) {
    // Taste learning: headline rewrites reveal the voice the team wants.
    await recordTasteSignal({
      brandId: campaign.brandId,
      creativeId,
      variantId,
      signalType: "headline_edit",
      payload: { platform: variant.platform, before: variant.headlineText, after: headline },
      userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || null,
    });
  }

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

  res.json(renderFallback ? { ...updated, renderFallback } : updated);
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

  await runVariantImageGeneration(req, res, campaign, variant, config, {
    briefText: instruction
      ? `${campaign.briefText || ""}\n\nADDITIONAL REFINEMENT: ${instruction}`
      : campaign.briefText || undefined,
    fileTag: "",
    tmpPrefix: "sparq-regen-",
    failureVerb: "regeneration",
    costOperation: "single_variant_regeneration",
    statusCode: 200,
    errorLabel: "Regeneration failed",
    persist: async (tx, files) => {
      const [result] = await tx.update(creativeVariantsTable)
        .set({
          rawImageUrl: `/api/files/generated/${files.rawFilename}`,
          compositedImageUrl: `/api/files/generated/${files.compFilename}`,
          compositingFailed: files.compositingFailed ? `Compositing failed during regeneration for ${variant.platform}. Using raw image as fallback.` : null,
          updatedAt: new Date(),
        })
        .where(eq(creativeVariantsTable.id, variantId))
        .returning();
      return result;
    },
    afterCost: async (tx) => {
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
    },
  });

  // Taste learning: a regenerate means the previous image wasn't right.
  await recordTasteSignal({
    brandId: campaign.brandId,
    creativeId,
    variantId,
    signalType: "regenerate",
    payload: { platform: variant.platform, reason: instruction || undefined },
    userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || null,
  });
});

// Board working format + shared helpers for the new /vary and /takes routes.
// Takes are explored at 1:1 (the instagram_feed config); fan-out to real
// platforms happens at Beat 4. Reusing an existing PLATFORM_CONFIGS key keeps
// /vary + compositing working on takes with zero config changes (and no impact
// on the /generate fan-out, which only adds a format when no platforms are
// passed). NOTE: /vary above still inlines the equivalent of these helpers —
// fold it in during the regenerate/vary/takes dedup. /generate + /regenerate
// are intentionally left untouched.
const BOARD_FORMAT = "instagram_feed";
const DEFAULT_TAKE_COUNT = 3;
const MAX_TAKE_COUNT = 4;

const TakesBody = z.object({
  count: z.number().int().min(1).max(MAX_TAKE_COUNT).default(DEFAULT_TAKE_COUNT),
});

// Reserve `estimatedCost` USD of daily-budget headroom (advisory-locked, same
// scheme as /generate and /regenerate). Returns the reservation id to settle
// later, or an `ok:false` result the caller turns into a 429.
async function reserveBudget(
  creativeId: string,
  estimatedCost: number,
): Promise<{ ok: true; reservationId: string | null } | { ok: false; todaySpend: number; threshold: number }> {
  const [thresholdRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "dailyCostThreshold"));
  const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  if (budgetThreshold === null || isNaN(budgetThreshold) || budgetThreshold <= 0) {
    return { ok: true, reservationId: null };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const estimatedGenerationCost = estimatedCost;
  const reservationId = crypto.randomUUID();

  const result = await db.transaction(async (tx) => {
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
      id: reservationId,
      creativeId,
      service: "system",
      operation: "budget_reservation",
      model: null,
      costUsd: estimatedGenerationCost,
    });
    return { exceeded: false as const, todaySpend: currentSpend };
  });

  if (result.exceeded) return { ok: false, todaySpend: result.todaySpend, threshold: budgetThreshold };
  return { ok: true, reservationId };
}

// Reserve daily-budget headroom for `imageCount` images (advisory-locked, same
// scheme as /generate and /regenerate). Returns the reservation id to settle
// later, or an `ok:false` result the caller turns into a 429.
async function reserveImageBudget(
  creativeId: string,
  imageCount: number,
): Promise<{ ok: true; reservationId: string | null } | { ok: false; todaySpend: number; threshold: number }> {
  return reserveBudget(creativeId, estimateImagenCost(imageCount));
}

function budgetExceededBody(todaySpend: number, threshold: number) {
  return {
    error: "Daily budget exceeded",
    todaySpend,
    threshold,
    message: `Today's spend ($${todaySpend.toFixed(2)}) has reached the daily budget limit ($${threshold.toFixed(2)}). Increase the limit in Cost Dashboard settings or wait until tomorrow.`,
  };
}

// Generate one image at `platform` for `campaign`, composite the overlay, and
// promote both files to UPLOADS_DIR; returns the public filenames. Cleans its
// own temp dir. On success the caller owns the promoted files (unlink them if a
// later DB write fails).
async function generateVariantImage(
  campaign: typeof creativesTable.$inferSelect,
  platform: string,
  opts: { varyMode?: VaryMode; headlineText?: string | null } = {},
): Promise<{ rawFilename: string; compFilename: string; compositingFailed: boolean }> {
  const config = PLATFORM_CONFIGS[platform];
  if (!config) throw new Error(`Unknown platform: ${platform}`);
  if (!campaign.templateId) throw new Error("Creative must have a template");

  const selectedAssets = (campaign.selectedAssets || []) as import("../services/context-assembly.js").SelectedAssetRef[];
  const selectedAssetIds = selectedAssets.map(a => a.assetId);

  const styleProfile = await resolveStyleProfile(campaign.brandId, campaign.styleProfileId);
  const styleRefIds = styleProfile?.referenceAssetIds || [];

  let packet: Awaited<ReturnType<typeof buildGenerationPacket>> | null = null;
  let referenceImages: ReferenceImage[] = [];
  if (selectedAssetIds.length > 0 || styleRefIds.length > 0) {
    packet = await buildGenerationPacket({
      creativeId: campaign.id,
      brandId: campaign.brandId,
      templateId: campaign.templateId,
      platform,
      selectedAssetIds,
      priorityStyleAssetIds: styleRefIds,
    });
    referenceImages = await buildReferenceImages(packet);
  }

  const ctx = await assembleContext({
    brandId: campaign.brandId,
    templateId: campaign.templateId,
    selectedAssets,
    selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
    briefText: campaign.briefText || undefined,
    referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
      intent: campaign.intent || undefined,
    generationPacket: packet,
    styleProfile,
  });

  const imgResult = await generateImage(ctx, platform, referenceImages, opts.varyMode);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sparq-variant-"));
  try {
    const token = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const tag = opts.varyMode ? "vary" : "take";
    const rawFilename = `${campaign.id}_${platform}_${token}_${tag}_raw.png`;
    fs.writeFileSync(path.join(tmpDir, rawFilename), imgResult.imageBuffer);

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
        headlineText: opts.headlineText ?? null,
        logoBuffer,
        width: config.width,
        height: config.height,
        fontFamily: brandFontFamily,
      });
      compositedBuffer = result.buffer;
    } catch (err) {
      console.error(`Compositing failed for ${platform}, using raw image:`, err instanceof Error ? err.message : err);
      compositedBuffer = imgResult.imageBuffer;
      compositingFailed = true;
    }

    const compFilename = `${campaign.id}_${platform}_${token}_${tag}_composited.png`;
    fs.writeFileSync(path.join(tmpDir, compFilename), compositedBuffer);

    try {
      await writeFromFile("generated", rawFilename, path.join(tmpDir, rawFilename));
      await writeFromFile("generated", compFilename, path.join(tmpDir, compFilename));
    } catch {
      await deleteGenerated(rawFilename);
      await deleteGenerated(compFilename);
      throw new Error("Failed to save generated files. Please try again.");
    }

    await recordAssetUsage(packetAssetIds(packet));

    return { rawFilename, compFilename, compositingFailed };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Shared single-variant image pipeline behind /regenerate and /vary. Both
// reserve one image's budget (advisory-locked), assemble packet/context,
// generate (optionally under a varyMode), composite, stage-to-tmp then promote
// the files, and persist + log cost in one transaction — differing only in the
// briefText, the varyMode, the file/operation labels, and the persistence step
// (update-in-place vs insert-with-lineage). This helper owns every shared step
// (including the budget 429, file staging/promotion, reservation settle, the
// gemini cost-log row, and all cleanup-on-error) and writes the success
// response itself. The caller supplies the route-specific bits:
//   - persist(tx, files): the UPDATE-or-INSERT, returning the variant row that
//     becomes the response body.
//   - afterCost(tx): optional extra writes that must run after the cost-log row
//     inside the same transaction (e.g. /regenerate's refinement log), to keep
//     the per-route transaction ordering byte-for-byte identical.
// Behavior is intentionally identical to the previous inlined routes; nothing
// observable (validations, budget semantics, cost-log rows, filenames, response
// body/status) changes.
async function runVariantImageGeneration(
  req: Request,
  res: Response,
  campaign: typeof creativesTable.$inferSelect,
  variant: typeof creativeVariantsTable.$inferSelect,
  config: (typeof PLATFORM_CONFIGS)[string],
  opts: {
    briefText: string | undefined;
    varyMode?: VaryMode;
    fileTag: string;
    tmpPrefix: string;
    failureVerb: string;
    costOperation: string;
    statusCode: number;
    errorLabel: string;
    persist: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      files: { rawFilename: string; compFilename: string; compositingFailed: boolean },
    ) => Promise<typeof creativeVariantsTable.$inferSelect>;
    afterCost?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>;
  },
): Promise<void> {
  const creativeId = campaign.id;

  const budget = await reserveImageBudget(creativeId, 1);
  if (!budget.ok) {
    res.status(429).json(budgetExceededBody(budget.todaySpend, budget.threshold));
    return;
  }
  const reservationId = budget.reservationId;

  let tmpDir: string | null = null;
  try {
    const selectedAssets = (campaign.selectedAssets || []) as import("../services/context-assembly.js").SelectedAssetRef[];
    const selectedAssetIds = selectedAssets.map(a => a.assetId);

    const styleProfile = await resolveStyleProfile(campaign.brandId, campaign.styleProfileId);
    const styleRefIds = styleProfile?.referenceAssetIds || [];

    let packet: Awaited<ReturnType<typeof buildGenerationPacket>> | null = null;
    let referenceImages: ReferenceImage[] = [];

    if (selectedAssetIds.length > 0 || styleRefIds.length > 0) {
      packet = await buildGenerationPacket({
        creativeId,
        brandId: campaign.brandId,
        templateId: campaign.templateId!,
        platform: variant.platform,
        selectedAssetIds,
        priorityStyleAssetIds: styleRefIds,
      });
      referenceImages = await buildReferenceImages(packet);
    }

    const ctx = await assembleContext({
      brandId: campaign.brandId,
      templateId: campaign.templateId!,
      selectedAssets,
      selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
      briefText: opts.briefText,
      referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
      intent: campaign.intent || undefined,
      generationPacket: packet,
      styleProfile,
    });

    const imgResult = await generateImage(ctx, variant.platform, referenceImages, opts.varyMode);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix));
    const ts = Date.now();
    const tag = opts.fileTag ? `_${opts.fileTag}` : "";
    const rawFilename = `${creativeId}_${variant.platform}_${ts}${tag}_raw.png`;
    const rawTmpPath = path.join(tmpDir, rawFilename);
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
      console.error(`Compositing failed during ${opts.failureVerb} for ${variant.platform}, using raw image:`, err instanceof Error ? err.message : err);
      compositedBuffer = imgResult.imageBuffer;
      compositingFailed = true;
    }

    const compFilename = `${creativeId}_${variant.platform}_${ts}${tag}_composited.png`;
    const compTmpPath = path.join(tmpDir, compFilename);
    fs.writeFileSync(compTmpPath, compositedBuffer);

    try {
      await writeFromFile("generated", rawFilename, rawTmpPath);
      await writeFromFile("generated", compFilename, compTmpPath);
    } catch (copyErr) {
      await deleteGenerated(rawFilename);
      await deleteGenerated(compFilename);
      throw new Error("Failed to save generated files. Please try again.");
    }

    let row;
    try {
      [row] = await db.transaction(async (tx) => {
        const result = await opts.persist(tx, { rawFilename, compFilename, compositingFailed });

        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }

        const cost = estimateImagenCost(1);
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "gemini",
          operation: opts.costOperation,
          model: AI_MODELS.GEMINI_FLASH_IMAGE,
          costUsd: cost,
        });

        if (opts.afterCost) {
          await opts.afterCost(tx);
        }

        return [result];
      });
    } catch (dbErr) {
      await deleteGenerated(rawFilename);
      await deleteGenerated(compFilename);
      throw dbErr;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;

    await recordAssetUsage(packetAssetIds(packet));

    res.status(opts.statusCode).json(row);
  } catch (error) {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    if (reservationId) {
      try {
        await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
      } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `${opts.errorLabel}: ${message}` });
  }
}

const VARY_MODES = ["more_like_this", "keep_style", "keep_subject"] as const;

const VaryBody = z.object({
  varyMode: z.enum(VARY_MODES),
});

// Beat 2 (Board) "Vary": generate a NEW variant from an existing one under a
// constraint mode, recording lineage (source_variant_id + vary_mode). Mirrors
// the /regenerate pipeline but inserts a new row instead of overwriting.
// NOTE: intentional near-duplicate of /regenerate — kept separate to avoid
// touching the working regenerate path; dedupe into a shared helper once there
// is runtime test coverage.
router.post("/creatives/:id/variants/:variantId/vary", generationLimiter, validateRequest({ params: CreativeVariantParams, body: VaryBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const varyMode = req.body.varyMode as VaryMode;

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

  await runVariantImageGeneration(req, res, campaign, variant, config, {
    briefText: campaign.briefText || undefined,
    varyMode,
    fileTag: "vary",
    tmpPrefix: "sparq-vary-",
    failureVerb: "vary",
    costOperation: "single_variant_vary",
    statusCode: 201,
    errorLabel: "Vary failed",
    persist: async (tx, files) => {
      const [result] = await tx.insert(creativeVariantsTable)
        .values({
          creativeId,
          platform: variant.platform,
          aspectRatio: variant.aspectRatio,
          rawImageUrl: `/api/files/generated/${files.rawFilename}`,
          compositedImageUrl: `/api/files/generated/${files.compFilename}`,
          caption: variant.caption,
          originalCaption: variant.caption,
          headlineText: variant.headlineText,
          originalHeadline: variant.headlineText,
          status: "generated",
          compositingFailed: files.compositingFailed ? `Compositing failed during vary for ${variant.platform}. Using raw image as fallback.` : null,
          sourceVariantId: variantId,
          varyMode,
        })
        .returning();
      return result;
    },
  });

  // Taste learning: a vary means the team liked this take enough to branch it.
  await recordTasteSignal({
    brandId: campaign.brandId,
    creativeId,
    variantId,
    signalType: "vary",
    payload: { varyMode, platform: variant.platform },
    userId: ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || null,
  });
});

// Beat 2 (Board) "Takes": generate a result set of N (default 3) exploratory
// takes of the creative's concept at the Board working format. These are
// originals (no source/vary lineage); platforms are assigned later at Fan-out.
router.post("/creatives/:id/takes", generationLimiter, validateRequest({ params: CreativeParams, body: TakesBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id);
  const count = req.body.count as number;

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }
  if (!campaign.templateId) {
    res.status(400).json({ error: "Creative must have a template" });
    return;
  }

  const budget = await reserveImageBudget(creativeId, count);
  if (!budget.ok) {
    res.status(429).json(budgetExceededBody(budget.todaySpend, budget.threshold));
    return;
  }
  const reservationId = budget.reservationId;

  try {
    // Each take is an independent sampling of the same concept (Gemini is
    // stochastic), so they read as distinct takes without per-take prompting.
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () => generateVariantImage(campaign, BOARD_FORMAT, {})),
    );
    const produced = settled
      .filter((s): s is PromiseFulfilledResult<{ rawFilename: string; compFilename: string; compositingFailed: boolean }> => s.status === "fulfilled")
      .map(s => s.value);

    if (produced.length === 0) {
      if (reservationId) {
        try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
      }
      res.status(502).json({ error: "Could not generate takes. Please try again." });
      return;
    }

    const config = PLATFORM_CONFIGS[BOARD_FORMAT];
    let created;
    try {
      created = await db.transaction(async (tx) => {
        const rows: (typeof creativeVariantsTable.$inferSelect)[] = [];
        for (const p of produced) {
          const [row] = await tx.insert(creativeVariantsTable)
            .values({
              creativeId,
              platform: BOARD_FORMAT,
              aspectRatio: config.aspectRatio,
              rawImageUrl: `/api/files/generated/${p.rawFilename}`,
              compositedImageUrl: `/api/files/generated/${p.compFilename}`,
              status: "generated",
              compositingFailed: p.compositingFailed ? `Compositing failed for ${BOARD_FORMAT}. Using raw image as fallback.` : null,
            })
            .returning();
          rows.push(row);
        }
        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "gemini",
          operation: "board_takes",
          model: AI_MODELS.GEMINI_FLASH_IMAGE,
          costUsd: estimateImagenCost(produced.length),
        });
        return rows;
      });
    } catch (dbErr) {
      for (const p of produced) {
        await deleteGenerated(p.rawFilename);
        await deleteGenerated(p.compFilename);
      }
      throw dbErr;
    }

    res.status(201).json({ takes: created });
  } catch (error) {
    if (reservationId) {
      try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Take generation failed: ${message}` });
  }
});

const FANOUT_PLATFORMS = ["instagram_feed", "instagram_story", "twitter", "linkedin", "tiktok"] as const;

const FanOutBody = z.object({
  platforms: z.array(z.enum(FANOUT_PLATFORMS)).nonempty(),
});

// Beat 4 (Fan-out / N1): take ONE winning take and deterministically reframe it
// (zero image regeneration) to every selected platform — cropped around the
// vision-detected subject focal point, with per-platform voice-adapted captions.
// Spends only on focal detection (1 vision call, cached on the take) + captions
// (1 Claude call); the reframes are free sharp crops of the winner's raw image.
router.post("/creatives/:id/variants/:variantId/fan-out", generationLimiter, validateRequest({ params: CreativeVariantParams, body: FanOutBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const platforms = req.body.platforms as string[];

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }
  if (!campaign.templateId) {
    res.status(400).json({ error: "Creative must have a template" });
    return;
  }

  const [winner] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variantId));
  if (!winner || winner.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }
  if (!winner.rawImageUrl) {
    res.status(400).json({ error: "Winning take has no source image to reframe" });
    return;
  }

  const winnerRawBuffer = await readFileByUrl(winner.rawImageUrl);
  if (!winnerRawBuffer) {
    res.status(400).json({ error: "Source image file not found" });
    return;
  }

  // Base billable AI calls on the cold path: a Gemini vision subject-detection
  // call (only when the take has no cached focal/box) and a Claude captions
  // call. Reserve the sum of their real estimates. Generative extras (auto
  // background extension for clipped crops, per-aspect headline re-render when
  // the winner's typography is AI-integrated) are reserved incrementally after
  // detection, when we know how many are needed.
  const needsSubjectDetection = !(winner.focalX != null && winner.focalY != null && winner.subjectBox);
  const estimatedSubjectCost = needsSubjectDetection ? estimateGeminiTextCost() : 0;
  const estimatedCaptionsCost = estimateClaudeCost();

  const budget = await reserveBudget(creativeId, estimatedSubjectCost + estimatedCaptionsCost);
  if (!budget.ok) {
    res.status(429).json(budgetExceededBody(budget.todaySpend, budget.threshold));
    return;
  }
  const reservationId = budget.reservationId;
  let extraReservationId: string | null = null;

  const writtenFiles: string[] = [];
  try {
    const rawBuffer = winnerRawBuffer;
    const { width: rawW, height: rawH } = await imageDimensions(rawBuffer);
    const sourceAspect = rawW && rawH ? rawW / rawH : 1;

    // Subject focal + bounding box: reuse the take's stored detection, else detect
    // once (vision) and cache it on the take. The box drives clip prediction.
    let focal: { x: number; y: number };
    let box: SubjectBox;
    if (!needsSubjectDetection) {
      focal = { x: winner.focalX!, y: winner.focalY! };
      box = winner.subjectBox as SubjectBox;
    } else {
      const detected = await detectSubject(rawBuffer);
      focal = detected.focal;
      box = detected.box;
      await db.update(creativeVariantsTable)
        .set({ focalX: focal.x, focalY: focal.y, subjectBox: box, updatedAt: new Date() })
        .where(eq(creativeVariantsTable.id, variantId));
    }

    // Plan the generative extras now that focal + box are known:
    //  - platforms whose safe crop would clip the subject → auto background
    //    extension (1 outpaint image call each; falls back to crop + warning);
    //  - AI-integrated headline typography on the winner → re-render the
    //    headline per aspect (image + OCR verify each; falls back to overlay).
    const validPlatforms = platforms.filter(p => PLATFORM_CONFIGS[p]);
    const clippedPlatforms = new Set(
      validPlatforms.filter(p => {
        const cfg = PLATFORM_CONFIGS[p];
        return predictClip(box, focal, sourceAspect, cfg.width / cfg.height);
      }),
    );
    const rerenderHeadlines = winner.headlineRenderMode === "rendered";
    const estimatedExtraCost =
      estimateImagenCost(clippedPlatforms.size) +
      (rerenderHeadlines
        ? validPlatforms.length * MAX_HEADLINE_RENDER_ATTEMPTS * (estimateImagenCost(1) + estimateGeminiTextCost())
        : 0);
    if (estimatedExtraCost > 0) {
      const extraBudget = await reserveBudget(creativeId, estimatedExtraCost);
      if (!extraBudget.ok) {
        if (reservationId) {
          try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
        }
        res.status(429).json(budgetExceededBody(extraBudget.todaySpend, extraBudget.threshold));
        return;
      }
      extraReservationId = extraBudget.reservationId;
    }

    // Per-platform captions (one Claude call covering all platforms).
    const selectedAssets = (campaign.selectedAssets || []) as import("../services/context-assembly.js").SelectedAssetRef[];
    const ctx = await assembleContext({
      brandId: campaign.brandId,
      templateId: campaign.templateId,
      selectedAssets,
      selectedHashtagSetIds: (campaign.selectedHashtagSets || []) as string[],
      briefText: campaign.briefText || undefined,
      referenceAnalysis: campaign.referenceAnalysis as Record<string, unknown> | null,
      intent: campaign.intent || undefined,
    });
    const captions = await generateCaptions(ctx);
    const captionsByPlatform = captions as unknown as Record<string, { caption?: string; headline?: string }>;

    const [logoBuffer, design] = await Promise.all([
      fetchLogoBuffer(campaign.brandId),
      fetchBrandDesign(campaign.brandId),
    ]);

    const ts = Date.now();
    let outpaintsUsed = 0;
    let headlineRenderAttempts = 0;
    const produced: {
      platform: string; aspectRatio: string; rawFn: string; compFn: string;
      caption: string; headline: string; warn: string | null; clip: boolean;
      renderMode: string | null;
    }[] = [];

    for (const platform of validPlatforms) {
      const config = PLATFORM_CONFIGS[platform];
      const cap = captionsByPlatform[platform] || {};
      const caption = cap.caption || "";
      const headline = cap.headline || "";
      const warns: string[] = [];

      // Reframe the winner's raw to this platform's aspect: crop around the
      // focal point, shifted so the whole subject box stays in frame when it
      // fits. When even the best crop would clip the subject, auto-extend the
      // background (outpaint) instead — falling back to the crop + warning if
      // the extension fails.
      let reframedRaw: Buffer;
      let clip = clippedPlatforms.has(platform);
      if (clip) {
        try {
          const extended = await outpaintImage(rawBuffer, "image/png", config.aspectRatio, campaign.briefText || undefined);
          outpaintsUsed++;
          reframedRaw = await reframeImage(extended, config.width, config.height, null);
          clip = false;
        } catch (outErr) {
          warns.push(`Auto background extension failed, used best-effort crop: ${outErr instanceof Error ? outErr.message : outErr}`);
          reframedRaw = await reframeImage(rawBuffer, config.width, config.height, focal, box);
        }
      } else {
        reframedRaw = await reframeImage(rawBuffer, config.width, config.height, focal, box);
      }

      // AI-integrated typography survives reframing by re-rendering per aspect;
      // verification failures fall back to the design-aware overlay.
      let baseBuffer = reframedRaw;
      let overlayHeadline: string | null = headline || null;
      let renderMode: string | null = headline ? "overlay" : null;
      if (rerenderHeadlines && headline) {
        try {
          const rendered = await renderHeadlineIntoImage(
            baseBuffer,
            "image/png",
            headline,
            {
              fontFamily: design.fontFamily,
              brandName: design.brandName,
              colorPrimary: design.colors.primary,
              colorSecondary: design.colors.secondary,
              colorAccent: design.colors.accent,
            },
            config.aspectRatio,
            () => { headlineRenderAttempts++; },
          );
          baseBuffer = rendered.buffer;
          overlayHeadline = null;
          renderMode = "rendered";
        } catch (renderErr) {
          if (!(renderErr instanceof HeadlineRenderError)) throw renderErr;
          warns.push("Headline re-render failed verification; applied the design-aware overlay.");
        }
      }

      const composited = await compositeImage({
        rawImageBuffer: baseBuffer,
        layoutSpec: ctx.template.layoutSpec as LayoutSpec | null,
        headlineText: overlayHeadline,
        logoBuffer,
        width: config.width,
        height: config.height,
        fontFamily: design.fontFamily,
        brandColors: design.colors,
        aspectRatio: config.aspectRatio,
      });
      warns.push(...composited.warnings);

      const token = `${ts}_${crypto.randomUUID().slice(0, 8)}`;
      const rawFn = `${creativeId}_${platform}_${token}_fanout_raw.png`;
      const compFn = `${creativeId}_${platform}_${token}_fanout_composited.png`;
      await writeBuffer("generated", rawFn, reframedRaw);
      await writeBuffer("generated", compFn, composited.buffer);
      writtenFiles.push(rawFn, compFn);

      produced.push({
        platform,
        aspectRatio: config.aspectRatio,
        rawFn,
        compFn,
        caption,
        headline,
        warn: warns.length ? warns.join("; ") : null,
        clip,
        renderMode,
      });
    }

    if (produced.length === 0) {
      if (reservationId) {
        try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
      }
      if (extraReservationId) {
        try { await db.delete(costLogsTable).where(eq(costLogsTable.id, extraReservationId)); } catch {}
      }
      res.status(400).json({ error: "No valid platforms selected" });
      return;
    }

    const focalPoint = focal;
    let created;
    try {
      created = await db.transaction(async (tx) => {
        const rows: (typeof creativeVariantsTable.$inferSelect)[] = [];
        for (const p of produced) {
          const [row] = await tx.insert(creativeVariantsTable).values({
            creativeId,
            platform: p.platform,
            aspectRatio: p.aspectRatio,
            rawImageUrl: `/api/files/generated/${p.rawFn}`,
            compositedImageUrl: `/api/files/generated/${p.compFn}`,
            caption: p.caption,
            originalCaption: p.caption,
            headlineText: p.headline || null,
            originalHeadline: p.headline || null,
            status: "generated",
            sourceVariantId: variantId,
            focalX: focalPoint.x,
            focalY: focalPoint.y,
            clipWarning: p.clip,
            compositingFailed: p.warn,
            headlineRenderMode: p.renderMode,
          }).returning();
          rows.push(row);
        }
        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }
        if (extraReservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, extraReservationId));
        }
        if (outpaintsUsed > 0) {
          await tx.insert(costLogsTable).values({
            creativeId,
            service: "gemini",
            operation: "fan_out_auto_outpaint",
            model: AI_MODELS.GEMINI_FLASH_IMAGE,
            costUsd: estimateImagenCost(outpaintsUsed),
          });
        }
        if (headlineRenderAttempts > 0) {
          await tx.insert(costLogsTable).values({
            creativeId,
            service: "gemini",
            operation: "fan_out_headline_render",
            model: AI_MODELS.GEMINI_FLASH_IMAGE,
            costUsd: estimateImagenCost(headlineRenderAttempts) + estimateGeminiTextCost() * headlineRenderAttempts,
          });
        }
        if (needsSubjectDetection) {
          await tx.insert(costLogsTable).values({
            creativeId,
            service: "gemini",
            operation: "fan_out_subject_detection",
            model: AI_MODELS.GEMINI_FLASH_TEXT,
            costUsd: estimatedSubjectCost,
          });
        }
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "anthropic",
          operation: "fan_out_captions",
          model: AI_MODELS.CLAUDE_SONNET,
          costUsd: estimateClaudeCost(),
        });
        return rows;
      });
    } catch (dbErr) {
      for (const fn of writtenFiles) {
        await deleteGenerated(fn);
      }
      throw dbErr;
    }

    res.status(201).json({ variants: created, focalPoint });

    // Taste learning: fan-out is the definitive "this take won" moment —
    // record the winner as selected and its unpicked Board siblings (takes
    // with no lineage or vary branches) as passed over. Fire-and-forget.
    void (async () => {
      const userId = ((req as unknown as Record<string, unknown>).user as AuthenticatedUser | undefined)?.id || null;
      await recordTasteSignal({
        brandId: campaign.brandId,
        creativeId,
        variantId,
        signalType: "take_selected",
        payload: { headline: winner.headlineText || undefined, varyMode: winner.varyMode || undefined },
        userId,
      });
      try {
        const siblings = await db.select().from(creativeVariantsTable)
          .where(and(
            eq(creativeVariantsTable.creativeId, creativeId),
            eq(creativeVariantsTable.platform, BOARD_FORMAT),
          ));
        for (const sib of siblings) {
          if (sib.id === variantId) continue;
          // Only Board takes/branches (fan-out children carry sourceVariantId without varyMode).
          if (sib.sourceVariantId && !sib.varyMode) continue;
          await recordTasteSignal({
            brandId: campaign.brandId,
            creativeId,
            variantId: sib.id,
            signalType: "take_passed_over",
            payload: { varyMode: sib.varyMode || undefined },
            userId,
          });
        }
      } catch (err) {
        console.error("Failed to record passed-over takes:", err instanceof Error ? err.message : err);
      }
    })();
    return;
  } catch (error) {
    for (const fn of writtenFiles) {
      await deleteGenerated(fn);
    }
    if (reservationId) {
      try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
    }
    if (extraReservationId) {
      try { await db.delete(costLogsTable).where(eq(costLogsTable.id, extraReservationId)); } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Fan-out failed: ${message}` });
  }
});

// Beat 4 escalation (free): re-aim a platform variant's crop at a new focal point,
// re-reframing from the original winning take — no model call.
router.put("/creatives/:id/variants/:variantId/refocus", validateRequest({ params: CreativeVariantParams, body: RefocusBody }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);
  const { focalX, focalY } = req.body as { focalX: number; focalY: number };

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign || !campaign.templateId) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }
  const [variant] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }
  if (!variant.sourceVariantId) {
    res.status(400).json({ error: "Variant has no source take to reframe from" });
    return;
  }
  const config = PLATFORM_CONFIGS[variant.platform];
  if (!config) {
    res.status(400).json({ error: "Unknown platform" });
    return;
  }
  const [winner] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variant.sourceVariantId));
  if (!winner || !winner.rawImageUrl) {
    res.status(400).json({ error: "Source take image not available" });
    return;
  }
  const rawBuffer = await readFileByUrl(winner.rawImageUrl);
  if (!rawBuffer) {
    res.status(400).json({ error: "Source image file not found" });
    return;
  }

  try {
    const { width: rawW, height: rawH } = await imageDimensions(rawBuffer);
    const sourceAspect = rawW && rawH ? rawW / rawH : 1;
    const focal = { x: focalX, y: focalY };

    const ctx = await assembleContext({ brandId: campaign.brandId, templateId: campaign.templateId, selectedAssets: [] });
    const [logoBuffer, design] = await Promise.all([
      fetchLogoBuffer(campaign.brandId),
      fetchBrandDesign(campaign.brandId),
    ]);

    const subjectBox = (winner.subjectBox as SubjectBox | null) ?? null;
    const reframedRaw = await reframeImage(rawBuffer, config.width, config.height, focal, subjectBox);
    const composited = await compositeImage({
      rawImageBuffer: reframedRaw,
      layoutSpec: ctx.template.layoutSpec as LayoutSpec | null,
      headlineText: variant.headlineText,
      logoBuffer,
      width: config.width,
      height: config.height,
      fontFamily: design.fontFamily,
      brandColors: design.colors,
      aspectRatio: config.aspectRatio,
    });

    const token = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const rawFn = `${creativeId}_${variant.platform}_${token}_refocus_raw.png`;
    const compFn = `${creativeId}_${variant.platform}_${token}_refocus_composited.png`;
    await writeBuffer("generated", rawFn, reframedRaw);
    await writeBuffer("generated", compFn, composited.buffer);

    const clip = subjectBox ? predictClip(subjectBox, focal, sourceAspect, config.width / config.height) : false;

    const [updated] = await db.update(creativeVariantsTable)
      .set({
        rawImageUrl: `/api/files/generated/${rawFn}`,
        compositedImageUrl: `/api/files/generated/${compFn}`,
        focalX,
        focalY,
        clipWarning: clip,
        compositingFailed: composited.warnings.length ? composited.warnings.join("; ") : null,
        updatedAt: new Date(),
      })
      .where(eq(creativeVariantsTable.id, variantId))
      .returning();

    res.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Refocus failed: ${message}` });
  }
});

// Beat 4 escalation (generative, +1 image call): extend the source take's
// background to this platform's aspect so the subject is no longer clipped, then
// recompose. Updates the platform variant in place.
router.post("/creatives/:id/variants/:variantId/outpaint", generationLimiter, validateRequest({ params: CreativeVariantParams }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign || !campaign.templateId) {
    res.status(404).json({ error: "Creative not found" });
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
  const sourceId = variant.sourceVariantId || variantId;
  const [winner] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, sourceId));
  if (!winner || !winner.rawImageUrl) {
    res.status(400).json({ error: "Source take image not available" });
    return;
  }
  const outpaintSrcBuffer = await readFileByUrl(winner.rawImageUrl);
  if (!outpaintSrcBuffer) {
    res.status(400).json({ error: "Source image file not found" });
    return;
  }

  const budget = await reserveImageBudget(creativeId, 1);
  if (!budget.ok) {
    res.status(429).json(budgetExceededBody(budget.todaySpend, budget.threshold));
    return;
  }
  const reservationId = budget.reservationId;

  const writtenFiles: string[] = [];
  try {
    const rawBuffer = outpaintSrcBuffer;
    const extended = await outpaintImage(rawBuffer, "image/png", config.aspectRatio, campaign.briefText || undefined);

    const ctx = await assembleContext({ brandId: campaign.brandId, templateId: campaign.templateId, selectedAssets: [] });
    const [logoBuffer, design] = await Promise.all([
      fetchLogoBuffer(campaign.brandId),
      fetchBrandDesign(campaign.brandId),
    ]);

    // The outpaint targets the platform aspect with the subject kept centered;
    // reframe centered to the exact pixel size, then overlay.
    const reframedRaw = await reframeImage(extended, config.width, config.height, null);
    const composited = await compositeImage({
      rawImageBuffer: reframedRaw,
      layoutSpec: ctx.template.layoutSpec as LayoutSpec | null,
      headlineText: variant.headlineText,
      logoBuffer,
      width: config.width,
      height: config.height,
      fontFamily: design.fontFamily,
      brandColors: design.colors,
      aspectRatio: config.aspectRatio,
    });

    const token = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const rawFn = `${creativeId}_${variant.platform}_${token}_outpaint_raw.png`;
    const compFn = `${creativeId}_${variant.platform}_${token}_outpaint_composited.png`;
    await writeBuffer("generated", rawFn, reframedRaw);
    await writeBuffer("generated", compFn, composited.buffer);
    writtenFiles.push(rawFn, compFn);

    let updated;
    try {
      [updated] = await db.transaction(async (tx) => {
        const [row] = await tx.update(creativeVariantsTable)
          .set({
            rawImageUrl: `/api/files/generated/${rawFn}`,
            compositedImageUrl: `/api/files/generated/${compFn}`,
            focalX: 0.5,
            focalY: 0.5,
            clipWarning: false,
            compositingFailed: composited.warnings.length ? composited.warnings.join("; ") : null,
            updatedAt: new Date(),
          })
          .where(eq(creativeVariantsTable.id, variantId))
          .returning();
        if (reservationId) {
          await tx.delete(costLogsTable).where(eq(costLogsTable.id, reservationId));
        }
        await tx.insert(costLogsTable).values({
          creativeId,
          service: "gemini",
          operation: "outpaint",
          model: AI_MODELS.GEMINI_FLASH_IMAGE,
          costUsd: estimateImagenCost(1),
        });
        return [row];
      });
    } catch (dbErr) {
      for (const fn of writtenFiles) {
        await deleteGenerated(fn);
      }
      throw dbErr;
    }

    res.json(updated);
  } catch (error) {
    for (const fn of writtenFiles) {
      await deleteGenerated(fn);
    }
    if (reservationId) {
      try { await db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)); } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Outpaint failed: ${message}` });
  }
});

export default router;

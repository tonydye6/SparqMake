import { str } from "../lib/http-params.js";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, creativesTable, creativeVariantsTable, brandsTable, templatesTable } from "@workspace/db";
import archiver from "archiver";
import * as path from "path";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { resolveUrl, readBuffer } from "../services/storage.js";

const DownloadParams = z.object({ id: z.string().uuid() });
const VariantDownloadParams = z.object({ id: z.string().uuid(), variantId: z.string().uuid() });

const router: IRouter = Router();

async function readByUrl(fileUrl: string): Promise<Buffer | null> {
  const loc = resolveUrl(fileUrl);
  if (!loc) return null;
  return readBuffer(loc);
}

router.get("/creatives/:id/download", validateRequest({ params: DownloadParams }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id);

  const [campaign] = await db.select().from(creativesTable).where(eq(creativesTable.id, creativeId));
  if (!campaign) {
    res.status(404).json({ error: "Creative not found" });
    return;
  }

  const variants = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.creativeId, creativeId));

  if (variants.length === 0) {
    res.status(400).json({ error: "No variants generated yet" });
    return;
  }

  let brandName = "Unknown";
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, campaign.brandId));
  if (brand) brandName = brand.name;

  let templateName = "Unknown";
  if (campaign.templateId) {
    const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, campaign.templateId));
    if (template) templateName = template.name;
  }

  const date = new Date().toISOString().split("T")[0];
  const safeName = campaign.name.replace(/[^a-zA-Z0-9]/g, "_");
  const zipName = `SparqMake_${safeName}_${date}`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create ZIP archive" });
    } else {
      res.end();
    }
  });
  archive.pipe(res);

  for (const variant of variants) {
    const platformDir = variant.platform.replace(/_/g, "_");

    if (variant.compositedImageUrl) {
      const filename = variant.compositedImageUrl.replace("/api/files/generated/", "");
      const buffer = await readByUrl(variant.compositedImageUrl);
      if (buffer) {
        const ext = path.extname(filename) || ".png";
        const ratioStr = variant.aspectRatio.replace(":", "x");
        archive.append(buffer, { name: `${zipName}/${platformDir}/final_${ratioStr}${ext}` });
      }
    }

    if (variant.rawImageUrl) {
      const filename = variant.rawImageUrl.replace("/api/files/generated/", "");
      const buffer = await readByUrl(variant.rawImageUrl);
      if (buffer) {
        const ext = path.extname(filename) || ".png";
        const ratioStr = variant.aspectRatio.replace(":", "x");
        archive.append(buffer, { name: `${zipName}/${platformDir}/raw_${ratioStr}${ext}` });
      }
    }

    if (variant.caption) {
      archive.append(variant.caption, { name: `${zipName}/${platformDir}/caption.txt` });
    }

    const metadata = {
      platform: variant.platform,
      aspectRatio: variant.aspectRatio,
      headline: variant.headlineText,
      status: variant.status,
      generatedAt: variant.createdAt,
    };
    archive.append(JSON.stringify(metadata, null, 2), { name: `${zipName}/${platformDir}/metadata.json` });
  }

  const videoVariants = variants.filter(v => v.videoUrl || v.mergedVideoUrl);
  if (videoVariants.length > 0) {
    for (const variant of videoVariants) {
      const videoFileUrl = variant.mergedVideoUrl || variant.videoUrl;
      if (videoFileUrl) {
        const buffer = await readByUrl(videoFileUrl);
        if (buffer) {
          const safeplatform = variant.platform.replace(/[^a-zA-Z0-9_-]/g, "_");
          archive.append(buffer, { name: `${zipName}/video/${safeplatform}_${variant.aspectRatio.replace(":", "x")}.mp4` });
        }
      }

      if (variant.audioUrl) {
        const buffer = await readByUrl(variant.audioUrl);
        if (buffer) {
          const safeplatform2 = variant.platform.replace(/[^a-zA-Z0-9_-]/g, "_");
          archive.append(buffer, { name: `${zipName}/video/${safeplatform2}_${variant.aspectRatio.replace(":", "x")}_audio.mp3` });
        }
      }
    }

    const videoMetadata = videoVariants.map(v => ({
      platform: v.platform,
      aspectRatio: v.aspectRatio,
      audioSource: v.audioSource,
      hasVideo: !!v.videoUrl,
      hasMergedVideo: !!v.mergedVideoUrl,
    }));
    archive.append(JSON.stringify(videoMetadata, null, 2), { name: `${zipName}/video/metadata.json` });
  }

  const creativeSummary = {
    creative: campaign.name,
    brand: brandName,
    template: templateName,
    status: campaign.status,
    brief: campaign.briefText,
    createdAt: campaign.createdAt,
    estimatedCost: campaign.estimatedCost,
    variantCount: variants.length,
    platforms: variants.map(v => v.platform),
  };
  archive.append(JSON.stringify(creativeSummary, null, 2), { name: `${zipName}/creative_summary.json` });

  await archive.finalize();
});

router.get("/creatives/:id/variants/:variantId/download", validateRequest({ params: VariantDownloadParams }), async (req: Request, res: Response): Promise<void> => {
  const creativeId = str(req.params.id), variantId = str(req.params.variantId);

  const [variant] = await db.select().from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, variantId));
  if (!variant || variant.creativeId !== creativeId) {
    res.status(404).json({ error: "Variant not found" });
    return;
  }

  const videoUrl = variant.mergedVideoUrl || variant.videoUrl;
  const imageUrl = variant.compositedImageUrl || variant.rawImageUrl;
  const fileUrl = videoUrl || imageUrl;
  if (!fileUrl) {
    res.status(400).json({ error: "No media available for download" });
    return;
  }

  const buffer = await readByUrl(fileUrl);
  if (!buffer) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const isVideo = !!videoUrl;
  const mimeType = isVideo ? "video/mp4" : "image/png";
  const ext = isVideo ? ".mp4" : ".png";
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${variant.platform}_${variant.aspectRatio.replace(":", "x")}${ext}"`);
  res.send(buffer);
});

export default router;

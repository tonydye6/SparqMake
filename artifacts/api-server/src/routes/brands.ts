import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, brandsTable, assetsTable, styleProfilesTable } from "@workspace/db";
import {
  CreateBrandBody,
  GetStyleProfilesParams,
  GetStyleProfilesResponse,
  CreateStyleProfileParams,
  CreateStyleProfileBody,
  UpdateStyleProfileParams,
  UpdateStyleProfileBody,
  UpdateStyleProfileResponse,
  DeleteStyleProfileParams,
  GetBrandParams,
  GetBrandsResponse,
  GetBrandResponse,
  UpdateBrandParams,
  UpdateBrandBody,
  UpdateBrandResponse,
  DeleteBrandParams,
  DeleteBrandResponse,
} from "@workspace/api-zod";
import { validateRequest } from "../middleware/validate.js";
import { requireDestructive } from "../middleware/auth.js";
import { recordAudit, actorFromRequest } from "../lib/audit.js";
import { z } from "zod";
import multer from "multer";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validateUploadedFile, validateFontFileBytes } from "../services/fileValidation.js";
import { writeFromFile } from "../services/storage.js";
import { softDeleteBackingObjects } from "../services/deletion.js";

const router: IRouter = Router();

const TMP_DIR = path.join(os.tmpdir(), "sparqmake-brand-uploads");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(TMP_DIR);
      cb(null, TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "image/svg+xml" ||
      path.extname(file.originalname).toLowerCase() === ".svg"
    ) {
      cb(new Error("SVG files are not allowed"));
      return;
    }
    cb(null, true);
  },
});

router.get("/brands", async (_req, res): Promise<void> => {
  const brands = await db.select().from(brandsTable).orderBy(brandsTable.name);
  res.json(GetBrandsResponse.parse(brands));
});

router.post("/brands", validateRequest({ body: CreateBrandBody }), async (req, res): Promise<void> => {
  const [brand] = await db.insert(brandsTable).values(req.body).returning();
  res.status(201).json(GetBrandResponse.parse(brand));
});

router.get("/brands/:id", validateRequest({ params: GetBrandParams }), async (req, res): Promise<void> => {
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, str(req.params.id)));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json(GetBrandResponse.parse(brand));
});

router.put("/brands/:id", validateRequest({ params: UpdateBrandParams, body: UpdateBrandBody }), async (req, res): Promise<void> => {
  const [brand] = await db
    .update(brandsTable)
    .set({ ...req.body, updatedAt: new Date() })
    .where(eq(brandsTable.id, str(req.params.id)))
    .returning();

  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json(UpdateBrandResponse.parse(brand));
});

router.delete("/brands/:id", requireDestructive, validateRequest({ params: DeleteBrandParams }), async (req, res): Promise<void> => {
  const [brand] = await db
    .update(brandsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(brandsTable.id, str(req.params.id)))
    .returning();
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  await recordAudit({
    actor: actorFromRequest(req),
    action: "brand.archive",
    entityType: "brand",
    entityIds: [brand.id],
    brandId: brand.id,
    metadata: { name: brand.name },
  });

  res.json(DeleteBrandResponse.parse({ message: "Brand archived" }));
});

router.get("/brands/:id/logos", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);

  const logos = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.assetClass, "compositing"),
      eq(assetsTable.type, "image"),
    ));

  res.json(logos);
});

router.post("/brands/:id/logos", upload.single("file"), async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const file = (req as any).file;

  if (!file) {
    res.status(400).json({ error: "Logo file is required" });
    return;
  }

  const allowedImageMimes = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
  if (!allowedImageMimes.includes(file.mimetype)) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.status(400).json({ error: `Invalid image format. Allowed: PNG, JPEG, WebP, GIF` });
    return;
  }

  const validation = await validateUploadedFile(file.path, file.mimetype, file.originalname, ["image"]);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  await writeFromFile("brand-assets", file.filename, file.path);
  try { fs.unlinkSync(file.path); } catch { /* ignore */ }

  const role = req.body.role || "primary";
  const name = req.body.name || `${brand.name} Logo (${role})`;
  const fileUrl = `/api/files/brand-assets/${file.filename}`;

  const userId = (req as any).user?.id || "system";

  const [asset] = await db.insert(assetsTable).values({
    brandId,
    type: "image",
    subType: `logo_${role}`,
    name,
    fileUrl,
    mimeType: file.mimetype,
    fileSizeBytes: file.size,
    uploadedBy: userId,
    assetClass: "compositing",
    generationRole: "compositing_logo",
    compositingOnly: true,
    generationAllowed: false,
    approvedForCompositing: true,
    status: "approved",
  }).returning();

  if (role === "primary") {
    await db.update(brandsTable)
      .set({ logoFileUrl: fileUrl, updatedAt: new Date() })
      .where(eq(brandsTable.id, brandId));

    const config = (brand.brandAssetConfig || {}) as Record<string, unknown>;
    config.primaryLogoAssetId = asset.id;
    await db.update(brandsTable)
      .set({ brandAssetConfig: config, updatedAt: new Date() })
      .where(eq(brandsTable.id, brandId));
  }

  res.status(201).json(asset);
});

router.delete("/brands/:id/logos/:assetId", requireDestructive, async (req, res): Promise<void> => {
  const brandId = str(req.params.id), assetId = str(req.params.assetId);

  const [asset] = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.id, assetId),
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.assetClass, "compositing"),
      eq(assetsTable.type, "image"),
    ));

  if (!asset) {
    res.status(404).json({ error: "Logo asset not found" });
    return;
  }

  // Delete the asset row AND clear any dangling brand references to it in the
  // same transaction, so no brand row is left pointing at the (soon soft-deleted)
  // logo file.
  await db.transaction(async (tx) => {
    await tx.delete(assetsTable).where(eq(assetsTable.id, assetId));

    const [brand] = await tx.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (!brand) return;

    const updates: Record<string, unknown> = {};
    if (brand.logoFileUrl && brand.logoFileUrl === asset.fileUrl) {
      updates.logoFileUrl = null;
    }
    const config = (brand.brandAssetConfig || {}) as Record<string, unknown>;
    if (config.primaryLogoAssetId === assetId || config.secondaryLogoAssetId === assetId) {
      const next = { ...config };
      if (next.primaryLogoAssetId === assetId) delete next.primaryLogoAssetId;
      if (next.secondaryLogoAssetId === assetId) delete next.secondaryLogoAssetId;
      updates.brandAssetConfig = next;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await tx.update(brandsTable).set(updates).where(eq(brandsTable.id, brandId));
    }
  });

  await recordAudit({
    actor: actorFromRequest(req),
    action: "brand.logo_delete",
    entityType: "asset",
    entityIds: [assetId],
    brandId,
    metadata: { name: asset.name },
  });

  const cleanup = await softDeleteBackingObjects([asset.fileUrl]);

  res.json({
    message: "Logo deleted",
    ...(cleanup.failed.length > 0 ? { storageCleanupFailed: cleanup.failed } : {}),
  });
});

router.get("/brands/:id/fonts", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);

  const fonts = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.type, "font"),
    ));

  res.json(fonts);
});

router.post("/brands/:id/fonts", upload.single("file"), async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const file = (req as any).file;

  if (!file) {
    res.status(400).json({ error: "Font file is required" });
    return;
  }

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const allowedExts = [".woff2", ".ttf", ".otf", ".woff"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExts.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.status(400).json({ error: `Invalid font format. Allowed: ${allowedExts.join(", ")}` });
    return;
  }

  const fontValidation = await validateFontFileBytes(file.path, ext);
  if (!fontValidation.ok) {
    try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    res.status(400).json({ error: fontValidation.error });
    return;
  }

  await writeFromFile("brand-assets", file.filename, file.path);
  try { fs.unlinkSync(file.path); } catch { /* ignore */ }

  const name = req.body.name || path.basename(file.originalname, ext);
  const weight = req.body.weight || "400";
  const fileUrl = `/api/files/brand-assets/${file.filename}`;
  const userId = (req as any).user?.id || "system";

  const mimeTypeMap: Record<string, string> = {
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
  };

  const [asset] = await db.insert(assetsTable).values({
    brandId,
    type: "font",
    subType: `weight_${weight}`,
    name,
    fileUrl,
    mimeType: mimeTypeMap[ext] || "application/octet-stream",
    fileSizeBytes: file.size,
    uploadedBy: userId,
    assetClass: "compositing",
    generationRole: "compositing_font",
    compositingOnly: true,
    generationAllowed: false,
    approvedForCompositing: true,
    status: "approved",
  }).returning();

  const existingFonts = (brand.brandFonts || []) as Array<Record<string, unknown>>;
  existingFonts.push({
    assetId: asset.id,
    name,
    weight,
    fileUrl,
    format: ext.replace(".", ""),
  });
  await db.update(brandsTable)
    .set({ brandFonts: existingFonts, updatedAt: new Date() })
    .where(eq(brandsTable.id, brandId));

  res.status(201).json(asset);
});

router.delete("/brands/:id/fonts/:assetId", requireDestructive, async (req, res): Promise<void> => {
  const brandId = str(req.params.id), assetId = str(req.params.assetId);

  const [asset] = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.id, assetId),
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.type, "font"),
    ));

  if (!asset) {
    res.status(404).json({ error: "Font asset not found" });
    return;
  }

  // Delete the asset row AND drop the font from the brand's brandFonts list in
  // the same transaction, so the brand never references a soft-deleted font file.
  await db.transaction(async (tx) => {
    await tx.delete(assetsTable).where(eq(assetsTable.id, assetId));

    const [brand] = await tx.select().from(brandsTable).where(eq(brandsTable.id, brandId));
    if (brand?.brandFonts) {
      const fonts = (brand.brandFonts as Array<Record<string, unknown>>).filter(f => f.assetId !== assetId);
      await tx.update(brandsTable)
        .set({ brandFonts: fonts, updatedAt: new Date() })
        .where(eq(brandsTable.id, brandId));
    }
  });

  await recordAudit({
    actor: actorFromRequest(req),
    action: "brand.font_delete",
    entityType: "asset",
    entityIds: [assetId],
    brandId,
    metadata: { name: asset.name },
  });

  const cleanup = await softDeleteBackingObjects([asset.fileUrl]);

  res.json({
    message: "Font deleted",
    ...(cleanup.failed.length > 0 ? { storageCleanupFailed: cleanup.failed } : {}),
  });
});

// --- Style profiles: named, reusable design styles per brand ---

/** Verify all referenced asset IDs belong to this brand; returns bad IDs. */
async function invalidAssetIds(brandId: string, assetIds: string[]): Promise<string[]> {
  if (assetIds.length === 0) return [];
  const rows = await db.select({ id: assetsTable.id }).from(assetsTable)
    .where(and(inArray(assetsTable.id, assetIds), eq(assetsTable.brandId, brandId)));
  const found = new Set(rows.map(r => r.id));
  return assetIds.filter(id => !found.has(id));
}

router.get("/brands/:id/style-profiles", validateRequest({ params: GetStyleProfilesParams }), async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const profiles = await db.select().from(styleProfilesTable)
    .where(eq(styleProfilesTable.brandId, brandId))
    .orderBy(styleProfilesTable.name);
  res.json(GetStyleProfilesResponse.parse(profiles));
});

router.post("/brands/:id/style-profiles", validateRequest({ params: CreateStyleProfileParams, body: CreateStyleProfileBody }), async (req, res): Promise<void> => {
  const brandId = str(req.params.id);

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const refIds = (req.body.referenceAssetIds || []) as string[];
  const logoId = req.body.defaultLogoAssetId as string | null | undefined;
  const bad = await invalidAssetIds(brandId, [...refIds, ...(logoId ? [logoId] : [])]);
  if (bad.length > 0) {
    res.status(400).json({ error: "Some assets do not belong to this brand", assetIds: bad });
    return;
  }

  const profile = await db.transaction(async (tx) => {
    // A new default unsets the previous one — at most one default per brand.
    if (req.body.isDefault) {
      await tx.update(styleProfilesTable)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(styleProfilesTable.brandId, brandId));
    }
    const [row] = await tx.insert(styleProfilesTable).values({
      brandId,
      name: req.body.name,
      description: req.body.description ?? "",
      styleDirection: req.body.styleDirection ?? "",
      colorTreatment: req.body.colorTreatment ?? "",
      referenceAssetIds: refIds,
      defaultLogoAssetId: logoId ?? null,
      isDefault: req.body.isDefault ?? false,
    }).returning();
    return row;
  });

  res.status(201).json(UpdateStyleProfileResponse.parse(profile));
});

router.put("/brands/:id/style-profiles/:profileId", validateRequest({ params: UpdateStyleProfileParams, body: UpdateStyleProfileBody }), async (req, res): Promise<void> => {
  const brandId = str(req.params.id), profileId = str(req.params.profileId);

  const [existing] = await db.select().from(styleProfilesTable)
    .where(and(eq(styleProfilesTable.id, profileId), eq(styleProfilesTable.brandId, brandId)));
  if (!existing) {
    res.status(404).json({ error: "Style profile not found" });
    return;
  }

  const refIds = req.body.referenceAssetIds as string[] | undefined;
  const logoId = req.body.defaultLogoAssetId as string | null | undefined;
  const bad = await invalidAssetIds(brandId, [...(refIds ?? []), ...(logoId ? [logoId] : [])]);
  if (bad.length > 0) {
    res.status(400).json({ error: "Some assets do not belong to this brand", assetIds: bad });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.styleDirection !== undefined) updates.styleDirection = req.body.styleDirection;
  if (req.body.colorTreatment !== undefined) updates.colorTreatment = req.body.colorTreatment;
  if (refIds !== undefined) updates.referenceAssetIds = refIds;
  if (logoId !== undefined) updates.defaultLogoAssetId = logoId;
  if (req.body.isDefault !== undefined) updates.isDefault = req.body.isDefault;

  const profile = await db.transaction(async (tx) => {
    if (req.body.isDefault === true) {
      await tx.update(styleProfilesTable)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(styleProfilesTable.brandId, brandId));
    }
    const [row] = await tx.update(styleProfilesTable)
      .set(updates)
      .where(and(eq(styleProfilesTable.id, profileId), eq(styleProfilesTable.brandId, brandId)))
      .returning();
    return row;
  });

  res.json(UpdateStyleProfileResponse.parse(profile));
});

router.delete("/brands/:id/style-profiles/:profileId", requireDestructive, validateRequest({ params: DeleteStyleProfileParams }), async (req, res): Promise<void> => {
  const brandId = str(req.params.id), profileId = str(req.params.profileId);

  const [deleted] = await db.delete(styleProfilesTable)
    .where(and(eq(styleProfilesTable.id, profileId), eq(styleProfilesTable.brandId, brandId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Style profile not found" });
    return;
  }

  await recordAudit({
    actor: actorFromRequest(req),
    action: "brand.style_profile_delete",
    entityType: "style_profile",
    entityIds: [profileId],
    brandId,
    metadata: { name: deleted.name },
  });

  res.json({ message: "Style profile deleted" });
});

const AssetConfigSchema = z.object({
  primaryLogoAssetId: z.string().uuid().optional(),
  secondaryLogoAssetId: z.string().uuid().optional(),
  primaryFontAssetId: z.string().uuid().optional(),
  secondaryFontAssetId: z.string().uuid().optional(),
  brandColors: z.array(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)).max(20).optional(),
  iconAssetIds: z.array(z.string().uuid()).max(50).optional(),
  templateOverrides: z.record(z.string(), z.unknown()).optional(),
}).strict();

router.put("/brands/:id/asset-config", async (req, res): Promise<void> => {
  const brandId = str(req.params.id);
  const parsed = AssetConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid asset config", details: parsed.error.issues });
    return;
  }
  const config = parsed.data;

  const [brand] = await db.update(brandsTable)
    .set({ brandAssetConfig: config, updatedAt: new Date() })
    .where(eq(brandsTable.id, brandId))
    .returning();

  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json(brand);
});

export default router;

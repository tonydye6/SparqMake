import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, brandsTable, assetsTable } from "@workspace/db";
import {
  CreateBrandBody,
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
import { requireRole } from "../middleware/auth.js";
import { z } from "zod";
import multer from "multer";
import * as fs from "fs";
import * as path from "path";
import { validateUploadedFile, validateFontFileBytes } from "../services/fileValidation.js";

const router: IRouter = Router();

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, "brand-assets");
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024,
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
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, req.params.id));
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
    .where(eq(brandsTable.id, req.params.id))
    .returning();

  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json(UpdateBrandResponse.parse(brand));
});

router.delete("/brands/:id", requireRole("admin"), validateRequest({ params: DeleteBrandParams }), async (req, res): Promise<void> => {
  const [brand] = await db
    .update(brandsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(brandsTable.id, req.params.id))
    .returning();
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json(DeleteBrandResponse.parse({ message: "Brand archived" }));
});

router.get("/brands/:id/logos", async (req, res): Promise<void> => {
  const brandId = req.params.id;

  const logos = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.assetClass, "compositing"),
      eq(assetsTable.type, "image"),
    ));

  res.json(logos);
});

router.post("/brands/:id/logos", upload.single("file"), async (req, res): Promise<void> => {
  const brandId = req.params.id;
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

router.delete("/brands/:id/logos/:assetId", async (req, res): Promise<void> => {
  const { id: brandId, assetId } = req.params;

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

  await db.delete(assetsTable).where(eq(assetsTable.id, assetId));
  res.json({ message: "Logo deleted" });
});

router.get("/brands/:id/fonts", async (req, res): Promise<void> => {
  const brandId = req.params.id;

  const fonts = await db.select().from(assetsTable)
    .where(and(
      eq(assetsTable.brandId, brandId),
      eq(assetsTable.type, "font"),
    ));

  res.json(fonts);
});

router.post("/brands/:id/fonts", upload.single("file"), async (req, res): Promise<void> => {
  const brandId = req.params.id;
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

router.delete("/brands/:id/fonts/:assetId", async (req, res): Promise<void> => {
  const { id: brandId, assetId } = req.params;

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

  await db.delete(assetsTable).where(eq(assetsTable.id, assetId));

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (brand?.brandFonts) {
    const fonts = (brand.brandFonts as Array<Record<string, unknown>>).filter(f => f.assetId !== assetId);
    await db.update(brandsTable)
      .set({ brandFonts: fonts, updatedAt: new Date() })
      .where(eq(brandsTable.id, brandId));
  }

  res.json({ message: "Font deleted" });
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
  const brandId = req.params.id;
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

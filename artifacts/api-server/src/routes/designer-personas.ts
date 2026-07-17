import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, designerPersonasTable, type PersonaReferenceImage } from "@workspace/db";
import { z } from "zod";
import multer from "multer";
import * as crypto from "crypto";
import { str } from "../lib/http-params.js";
import { validateRequest } from "../middleware/validate.js";
import { requireStandardWrite, requireDestructive } from "../middleware/auth.js";
import { recordAudit, actorFromRequest } from "../lib/audit.js";
import { validateUrl, captureScreenshots } from "../services/screenshot.js";
import { analyzePersonaImages, type PersonaImageInput } from "../services/persona-analysis.js";
import { writeBuffer } from "../services/storage.js";

// Designer Personas — account-scoped "Inspired by ..." style inspirations.
// CRUD + the AI builder (analyze). Analyze NEVER persists: it returns a draft
// fingerprint for the review-before-save step in the Designers UI.

const router: IRouter = Router();

const ReferenceImageSchema = z.object({
  url: z.string().min(1).max(2048),
  label: z.string().max(200).optional(),
});

const PersonaBodyBase = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  sourceType: z.enum(["manual", "url", "samples"]).default("manual"),
  sourceUrl: z.string().max(2048).nullable().optional(),
  typography: z.string().max(4000).default(""),
  composition: z.string().max(4000).default(""),
  colorPhilosophy: z.string().max(4000).default(""),
  textureAndEffects: z.string().max(4000).default(""),
  mood: z.string().max(2000).default(""),
  referenceImages: z.array(ReferenceImageSchema).max(20).default([]),
};

const CreatePersonaBody = z.object(PersonaBodyBase);
const UpdatePersonaBody = z.object(
  Object.fromEntries(
    Object.entries(PersonaBodyBase).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
  ) as { [K in keyof typeof PersonaBodyBase]: z.ZodOptional<z.ZodTypeAny> },
);
const PersonaParams = z.object({ id: z.string().min(1) });

router.get("/designer-personas", async (_req, res): Promise<void> => {
  const personas = await db.select().from(designerPersonasTable)
    .orderBy(designerPersonasTable.name);
  res.json({ data: personas });
});

router.post("/designer-personas", requireStandardWrite, validateRequest({ body: CreatePersonaBody }), async (req, res): Promise<void> => {
  const body = req.body as z.infer<typeof CreatePersonaBody>;
  const [persona] = await db.insert(designerPersonasTable).values({
    name: body.name,
    description: body.description ?? "",
    sourceType: body.sourceType ?? "manual",
    sourceUrl: body.sourceUrl ?? null,
    typography: body.typography ?? "",
    composition: body.composition ?? "",
    colorPhilosophy: body.colorPhilosophy ?? "",
    textureAndEffects: body.textureAndEffects ?? "",
    mood: body.mood ?? "",
    referenceImages: (body.referenceImages ?? []) as PersonaReferenceImage[],
  }).returning();

  await recordAudit({
    actor: actorFromRequest(req),
    action: "designer_persona.create",
    entityType: "designer_persona",
    entityIds: [persona.id],
    metadata: { name: persona.name, sourceType: persona.sourceType },
  });

  res.status(201).json(persona);
});

router.put("/designer-personas/:id", requireStandardWrite, validateRequest({ params: PersonaParams, body: UpdatePersonaBody }), async (req, res): Promise<void> => {
  const id = str(req.params.id);
  const body = req.body as Partial<z.infer<typeof CreatePersonaBody>>;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "description", "sourceType", "sourceUrl", "typography", "composition", "colorPhilosophy", "textureAndEffects", "mood", "referenceImages"] as const) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  const [persona] = await db.update(designerPersonasTable)
    .set(updates)
    .where(eq(designerPersonasTable.id, id))
    .returning();

  if (!persona) {
    res.status(404).json({ error: "Designer persona not found" });
    return;
  }

  res.json(persona);
});

router.delete("/designer-personas/:id", requireDestructive, validateRequest({ params: PersonaParams }), async (req, res): Promise<void> => {
  const id = str(req.params.id);
  const [deleted] = await db.delete(designerPersonasTable)
    .where(eq(designerPersonasTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Designer persona not found" });
    return;
  }

  await recordAudit({
    actor: actorFromRequest(req),
    action: "designer_persona.delete",
    entityType: "designer_persona",
    entityIds: [id],
    metadata: { name: deleted.name },
  });

  res.json({ message: "Designer persona deleted" });
});

// --- Work sample upload: append sample images to an existing persona.
// Multipart (field "images", up to 6 per request, 10 max total refs). Files
// are stored and the persona's referenceImages list is updated atomically;
// returns the updated persona.

router.post("/designer-personas/:id/reference-images", requireStandardWrite, validateRequest({ params: PersonaParams }), (req, res): void => {
  upload.array("images", 20)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }
    try {
      const id = str(req.params.id);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: "Provide at least one sample image" });
        return;
      }

      const [persona] = await db.select().from(designerPersonasTable)
        .where(eq(designerPersonasTable.id, id));
      if (!persona) {
        res.status(404).json({ error: "Designer persona not found" });
        return;
      }

      const existing = (persona.referenceImages || []) as PersonaReferenceImage[];
      if (existing.length + files.length > 20) {
        res.status(400).json({ error: `A designer can have at most 20 reference images (currently ${existing.length})` });
        return;
      }

      const token = crypto.randomUUID().slice(0, 8);
      const added: PersonaReferenceImage[] = [];
      for (const [i, file] of files.entries()) {
        const ext = file.mimetype === "image/jpeg" ? ".jpg" : file.mimetype === "image/webp" ? ".webp" : file.mimetype === "image/gif" ? ".gif" : ".png";
        const filename = `persona-${token}-sample-${i + 1}-${Date.now()}${ext}`;
        await writeBuffer("generated", filename, file.buffer);
        added.push({ url: `/api/files/generated/${filename}`, label: file.originalname || `Sample ${existing.length + i + 1}` });
      }

      const [updated] = await db.update(designerPersonasTable)
        .set({ referenceImages: [...existing, ...added], updatedAt: new Date() })
        .where(eq(designerPersonasTable.id, id))
        .returning();

      await recordAudit({
        actor: actorFromRequest(req),
        action: "designer_persona.add_reference_images",
        entityType: "designer_persona",
        entityIds: [id],
        metadata: { added: added.length, total: (updated.referenceImages as PersonaReferenceImage[]).length },
      });

      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
});

// --- AI builder: analyze a portfolio URL or uploaded sample images into a
// draft fingerprint. Returns the draft + stored reference image URLs; nothing
// is persisted to the personas table (review-before-save).

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPEG, WebP, or GIF images are allowed"));
  },
});

router.post("/designer-personas/analyze", requireStandardWrite, (req, res): void => {
  upload.array("images", 20)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

      if (files.length === 0 && !url) {
        res.status(400).json({ error: "Provide a portfolio URL or at least one sample image" });
        return;
      }

      const token = crypto.randomUUID().slice(0, 8);
      const referenceImages: PersonaReferenceImage[] = [];
      const analysisInputs: PersonaImageInput[] = [];
      let sourceType: "url" | "samples" = "samples";
      let sourceUrl: string | null = null;

      if (url) {
        validateUrl(url);
        sourceType = "url";
        sourceUrl = url;
        const shots = await captureScreenshots(url, `persona-${token}`);
        for (const shot of shots) {
          referenceImages.push({ url: shot.url, label: `Portfolio (${shot.viewport})` });
          analysisInputs.push({ buffer: shot.buffer, mimeType: shot.mimeType });
        }
      }

      for (const [i, file] of files.entries()) {
        const ext = file.mimetype === "image/jpeg" ? ".jpg" : file.mimetype === "image/webp" ? ".webp" : file.mimetype === "image/gif" ? ".gif" : ".png";
        const filename = `persona-${token}-sample-${i + 1}-${Date.now()}${ext}`;
        await writeBuffer("generated", filename, file.buffer);
        referenceImages.push({ url: `/api/files/generated/${filename}`, label: file.originalname || `Sample ${i + 1}` });
        analysisInputs.push({ buffer: file.buffer, mimeType: file.mimetype });
      }

      const fingerprint = await analyzePersonaImages(analysisInputs);

      res.json({
        draft: {
          ...fingerprint,
          sourceType,
          sourceUrl,
          referenceImages,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const clientError = /Invalid URL|not allowed|Only http|at least one|No valid images|not configured/.test(message);
      res.status(clientError ? 400 : 500).json({ error: message });
    }
  });
});

export default router;

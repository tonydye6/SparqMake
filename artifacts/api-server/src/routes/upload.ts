import { Router, type IRouter } from "express";
import { UploadFileResponse } from "@workspace/api-zod";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { validateUploadedFile, type FileCategory } from "../services/fileValidation.js";
import { serveStored, writeFromFile, type StorageNamespace } from "../services/storage.js";
import { isFileReferenced } from "../services/file-ownership.js";

const router: IRouter = Router();

// Multer stages the upload to a local temp dir; after validation we move the
// final bytes into the storage service (bucket or disk) and delete the temp
// file. The durable copy never lives in the ephemeral request dir.
const STAGING_DIR = path.join(os.tmpdir(), "sparqmake-uploads");
if (!fs.existsSync(STAGING_DIR)) {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, STAGING_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".bin";
    const fileId = crypto.randomUUID();
    cb(null, `${fileId}${ext}`);
  },
});

const ALLOWED_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "font/woff2",
  "font/ttf",
  "application/x-font-woff2",
  "application/x-font-ttf",
  "audio/mpeg",
  "audio/wav",
  "application/pdf",
] as const;

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIMES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  },
});

const MIME_TO_CATEGORY: Record<string, FileCategory> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "font/woff2": "font",
  "font/ttf": "font",
  "application/x-font-woff2": "font",
  "application/x-font-ttf": "font",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "application/pdf": "pdf",
};

router.post("/upload", (req, res, _next) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(400).json({ error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const cleanupTemp = () => {
      try { fs.unlinkSync(req.file!.path); } catch { /* ignore */ }
    };

    const category = MIME_TO_CATEGORY[req.file.mimetype];
    if (!category) {
      cleanupTemp();
      res.status(400).json({ error: `File type ${req.file.mimetype} not allowed` });
      return;
    }

    const validation = await validateUploadedFile(
      req.file.path,
      req.file.mimetype,
      req.file.originalname,
      [category],
    );
    if (!validation.ok) {
      cleanupTemp();
      res.status(400).json({ error: validation.error });
      return;
    }

    try {
      await writeFromFile("uploads", req.file.filename, req.file.path);
    } catch {
      cleanupTemp();
      res.status(500).json({ error: "Failed to store uploaded file" });
      return;
    }
    cleanupTemp();

    const url = `/api/files/${req.file.filename}`;
    res.json(UploadFileResponse.parse({ url }));
  });
});

// Public router — mounted BEFORE requireAuth in app.ts.
// Instagram (image_url) and TikTok (PULL_FROM_URL) fetch generated media
// server-side with no session cookie, so this route must be unauthenticated.
// Filenames are unguessable UUIDs and the content is published publicly anyway;
// serveStored() still rejects path traversal + pins the namespace.
export const publicFilesRouter: IRouter = Router();

publicFilesRouter.get("/files/generated/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  void serveStored({ namespace: "generated", filename }, req, res);
});

// Raw uploads + brand assets stay behind requireAuth (the browser sends the
// cookie). On top of auth we require that the file is referenced by a durable
// DB record — unknown / orphaned objects are rejected (404) so an authenticated
// client cannot probe arbitrary bucket keys. See services/file-ownership.ts for
// the (partial, no-tenant-model) isolation this provides.
export async function serveOwnedFile(namespace: StorageNamespace, req: import("express").Request, res: import("express").Response): Promise<void> {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const loc = { namespace, filename };
  if (!(await isFileReferenced(loc))) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  await serveStored(loc, req, res);
}

router.get("/files/:filename", (req, res): void => {
  void serveOwnedFile("uploads", req, res);
});

router.get("/files/brand-assets/:filename", (req, res): void => {
  void serveOwnedFile("brand-assets", req, res);
});

// Curated asset-library media lives in its own namespace (NOT brand-assets) so
// the idempotent importer's reset can never delete app-uploaded brand logos.
router.get("/files/assets/:filename", (req, res): void => {
  void serveOwnedFile("assets", req, res);
});

// Curated asset-library media lives in its own subdir (NOT brand-assets) so the
// idempotent importer's reset can never delete app-uploaded brand logos.
router.get("/files/assets/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "assets"), filename, res);
});

export default router;

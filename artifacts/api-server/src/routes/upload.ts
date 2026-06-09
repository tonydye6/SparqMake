import { Router, type IRouter } from "express";
import { UploadFileResponse } from "@workspace/api-zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { validateUploadedFile, type FileCategory } from "../services/fileValidation.js";

const router: IRouter = Router();

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
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

    const category = MIME_TO_CATEGORY[req.file.mimetype];
    if (!category) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
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
      res.status(400).json({ error: validation.error });
      return;
    }

    const url = `/api/files/${req.file.filename}`;
    res.json(UploadFileResponse.parse({ url }));
  });
});

function serveFile(baseDir: string, filename: string, res: any): void {
  if (!filename || filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const filePath = path.join(baseDir, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
  };

  const contentType = mimeTypes[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filename)}"`);
  }
  res.sendFile(filePath);
}

// Public router — mounted BEFORE requireAuth in app.ts.
// Instagram (image_url) and TikTok (PULL_FROM_URL) fetch generated media
// server-side with no session cookie, so this route must be unauthenticated.
// Filenames are unguessable UUIDs, the content is published publicly anyway,
// and serveFile() still rejects path traversal + pins the directory.
export const publicFilesRouter: IRouter = Router();

publicFilesRouter.get("/files/generated/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "generated"), filename, res);
});

// Raw uploads + brand assets stay behind requireAuth (the browser sends the cookie).
router.get("/files/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(UPLOAD_DIR, filename, res);
});

router.get("/files/brand-assets/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "brand-assets"), filename, res);
});

// Curated asset-library media lives in its own subdir (NOT brand-assets) so the
// idempotent importer's reset can never delete app-uploaded brand logos.
router.get("/files/assets/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "assets"), filename, res);
});

export default router;

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import type { Request, Response } from "express";
import { Client as ObjectStorageClient } from "@replit/object-storage";
import { logger } from "../lib/logger.js";

/**
 * Centralized file storage service.
 *
 * Every durable file in SparqMake (raw uploads, brand logos/fonts, generated
 * media, screenshots, curated asset-library media) flows through this module.
 * It writes/reads/deletes against Replit Object Storage when a bucket is
 * provisioned (DEFAULT_OBJECT_STORAGE_BUCKET_ID is set) and transparently falls
 * back to the local `uploads/` disk tree otherwise. Reads are dual: we try the
 * configured primary backend first and fall back to the other so a file written
 * before the migration (disk) is still served after it (bucket) and vice-versa.
 *
 * The public `/api/files/...` URLs are preserved exactly — callers keep storing
 * the same URL strings in the DB; only the bytes move.
 *
 * Rollout / rollback is controlled by STORAGE_BACKEND:
 *   - unset / "auto" / "bucket": write to the bucket when configured (default)
 *   - "disk": force new writes to local disk (reversible kill-switch). Reads
 *     still fall back to the bucket so previously-migrated files keep working.
 */

export type StorageNamespace = "uploads" | "brand-assets" | "generated" | "assets";

interface NamespaceConfig {
  /** Object-storage key prefix, e.g. "generated/". */
  bucketPrefix: string;
  /** Local disk directory, relative to the uploads root. */
  diskSubdir: string;
}

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
const TRASH_PREFIX = "trash/";

const NAMESPACES: Record<StorageNamespace, NamespaceConfig> = {
  uploads: { bucketPrefix: "uploads/", diskSubdir: "" },
  "brand-assets": { bucketPrefix: "brand-assets/", diskSubdir: "brand-assets" },
  generated: { bucketPrefix: "generated/", diskSubdir: "generated" },
  assets: { bucketPrefix: "assets/", diskSubdir: "assets" },
};

export const OBJECT_STORAGE_CONFIGURED = Boolean(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID);

/** True when new writes should target the bucket. */
export function bucketWritesEnabled(): boolean {
  if (!OBJECT_STORAGE_CONFIGURED) return false;
  const backend = (process.env.STORAGE_BACKEND || "auto").toLowerCase();
  return backend !== "disk";
}

/**
 * Log the effective storage backend at startup. In production, writing media
 * to local disk is data loss waiting to happen: deployment disks are ephemeral
 * and every republish wipes them (this already destroyed all production-era
 * generated images once). Make that state impossible to miss in the logs.
 */
export function logStorageStartupStatus(): void {
  const production = process.env.NODE_ENV === "production";
  if (bucketWritesEnabled()) {
    logger.info(
      { bucketConfigured: true, backend: "bucket" },
      "Storage: writing media to Object Storage bucket",
    );
    return;
  }
  const reason = OBJECT_STORAGE_CONFIGURED
    ? "STORAGE_BACKEND=disk kill-switch is set"
    : "DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set (no bucket configured)";
  if (production) {
    logger.error(
      { bucketConfigured: OBJECT_STORAGE_CONFIGURED, backend: "disk" },
      `*** STORAGE MISCONFIGURED IN PRODUCTION *** Media writes are going to EPHEMERAL DISK because ${reason}. ` +
        "Every uploaded/generated file will be PERMANENTLY LOST on the next republish. " +
        "Attach an Object Storage bucket to the deployment (DEFAULT_OBJECT_STORAGE_BUCKET_ID) before generating media.",
    );
  } else {
    logger.warn(
      { bucketConfigured: OBJECT_STORAGE_CONFIGURED, backend: "disk" },
      `Storage: writing media to local disk (${reason})`,
    );
  }
}

let objectStorageClient: ObjectStorageClient | null = null;
function client(): ObjectStorageClient {
  if (!objectStorageClient) objectStorageClient = new ObjectStorageClient();
  return objectStorageClient;
}

// ---------------------------------------------------------------------------
// Location model
// ---------------------------------------------------------------------------

export interface StorageLocation {
  namespace: StorageNamespace;
  filename: string;
}

/** Reject path traversal / nested paths. Filenames are flat within a namespace. */
function isSafeFilename(filename: string): boolean {
  return Boolean(filename) && !filename.includes("..") && !filename.includes("/") && !filename.includes("\\");
}

function bucketKey(loc: StorageLocation): string {
  return NAMESPACES[loc.namespace].bucketPrefix + loc.filename;
}

function diskPath(loc: StorageLocation): string {
  const sub = NAMESPACES[loc.namespace].diskSubdir;
  return sub ? path.join(UPLOAD_ROOT, sub, loc.filename) : path.join(UPLOAD_ROOT, loc.filename);
}

function diskDir(namespace: StorageNamespace): string {
  const sub = NAMESPACES[namespace].diskSubdir;
  return sub ? path.join(UPLOAD_ROOT, sub) : UPLOAD_ROOT;
}

/** Public URL ("/api/files/...") for a stored object. Unchanged by the backend. */
export function publicUrlFor(loc: StorageLocation): string {
  const cfg = NAMESPACES[loc.namespace];
  if (loc.namespace === "uploads") return `/api/files/${loc.filename}`;
  return `/api/files/${cfg.bucketPrefix}${loc.filename}`;
}

/**
 * Map a stored "/api/files/..." URL back to a {namespace, filename}. Returns
 * null for URLs that are external (http...) or otherwise not bucket-managed.
 */
export function resolveUrl(fileUrl: string | null | undefined): StorageLocation | null {
  if (!fileUrl) return null;
  let p = fileUrl;
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  const m = p.match(/\/api\/files\/(.+)$/);
  if (!m) return null;
  const rest = decodeURIComponent(m[1]);
  for (const ns of ["generated", "brand-assets", "assets"] as const) {
    const prefix = `${ns}/`;
    if (rest.startsWith(prefix)) {
      const filename = rest.slice(prefix.length);
      if (!isSafeFilename(filename)) return null;
      return { namespace: ns, filename };
    }
  }
  if (!isSafeFilename(rest)) return null;
  return { namespace: "uploads", filename: rest };
}

// ---------------------------------------------------------------------------
// Content type / headers
// ---------------------------------------------------------------------------

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
};

export function contentTypeFor(filename: string): string {
  return EXT_TO_MIME[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function isInlineType(contentType: string): boolean {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/")
  );
}

// ---------------------------------------------------------------------------
// Bucket read cache (the @replit SDK has no native ranged read, so a range
// request downloads the whole object; cache it briefly so video seeking — which
// issues many small Range requests for the same key — does not re-download the
// object every time).
// ---------------------------------------------------------------------------

interface CacheEntry {
  buffer: Buffer;
  expires: number;
}
const READ_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_TOTAL_BYTES = 192 * 1024 * 1024;
let cacheTotalBytes = 0;

function cacheGet(key: string): Buffer | null {
  const e = READ_CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    READ_CACHE.delete(key);
    cacheTotalBytes -= e.buffer.length;
    return null;
  }
  return e.buffer;
}

function cachePut(key: string, buffer: Buffer): void {
  if (buffer.length > CACHE_MAX_OBJECT_BYTES) return;
  while (cacheTotalBytes + buffer.length > CACHE_MAX_TOTAL_BYTES && READ_CACHE.size > 0) {
    const oldestKey = READ_CACHE.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const old = READ_CACHE.get(oldestKey);
    READ_CACHE.delete(oldestKey);
    if (old) cacheTotalBytes -= old.buffer.length;
  }
  READ_CACHE.set(key, { buffer, expires: Date.now() + CACHE_TTL_MS });
  cacheTotalBytes += buffer.length;
}

function cacheInvalidate(key: string): void {
  const e = READ_CACHE.get(key);
  if (e) {
    READ_CACHE.delete(key);
    cacheTotalBytes -= e.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// Low-level backend access
// ---------------------------------------------------------------------------

async function bucketDownload(loc: StorageLocation): Promise<Buffer | null> {
  const key = bucketKey(loc);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await client().downloadAsBytes(key);
    if (!res.ok) return null;
    const buf = res.value[0];
    cachePut(key, buf);
    return buf;
  } catch (err) {
    logger.error({ err, key }, "Object storage download failed");
    return null;
  }
}

interface DiskStat {
  path: string;
  size: number;
  mtimeMs: number;
}

async function diskStat(loc: StorageLocation): Promise<DiskStat | null> {
  const p = diskPath(loc);
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return null;
    return { path: p, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public read/write/delete API
// ---------------------------------------------------------------------------

/** Whether an object exists in either backend. */
export async function objectExists(loc: StorageLocation): Promise<boolean> {
  if (!isSafeFilename(loc.filename)) return false;
  if (OBJECT_STORAGE_CONFIGURED) {
    try {
      const res = await client().exists(bucketKey(loc));
      if (res.ok && res.value) return true;
    } catch (err) {
      logger.error({ err, loc }, "Object storage exists check failed");
    }
  }
  return Boolean(await diskStat(loc));
}

/** Read an object's full bytes from whichever backend has it. */
export async function readBuffer(loc: StorageLocation): Promise<Buffer | null> {
  if (!isSafeFilename(loc.filename)) return null;
  const tryBucketFirst = bucketWritesEnabled();

  if (tryBucketFirst) {
    const buf = await bucketDownload(loc);
    if (buf) return buf;
  }

  const st = await diskStat(loc);
  if (st) {
    try {
      return await fsp.readFile(st.path);
    } catch (err) {
      logger.error({ err, loc }, "Disk read failed");
    }
  }

  if (!tryBucketFirst && OBJECT_STORAGE_CONFIGURED) {
    const buf = await bucketDownload(loc);
    if (buf) return buf;
  }
  return null;
}

/** Write bytes to the active backend. Returns the stored location. */
export async function writeBuffer(
  namespace: StorageNamespace,
  filename: string,
  data: Buffer,
): Promise<StorageLocation> {
  if (!isSafeFilename(filename)) {
    throw new Error(`Unsafe storage filename: ${filename}`);
  }
  const loc: StorageLocation = { namespace, filename };
  if (bucketWritesEnabled()) {
    const res = await client().uploadFromBytes(bucketKey(loc), data);
    if (!res.ok) {
      throw new Error(`Object storage upload failed: ${res.error.message}`);
    }
    cacheInvalidate(bucketKey(loc));
  } else {
    const dir = diskDir(namespace);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(diskPath(loc), data);
  }
  return loc;
}

/** Write an object by reading bytes from a local temp file, then return location. */
export async function writeFromFile(
  namespace: StorageNamespace,
  filename: string,
  srcPath: string,
): Promise<StorageLocation> {
  if (!isSafeFilename(filename)) {
    throw new Error(`Unsafe storage filename: ${filename}`);
  }
  const loc: StorageLocation = { namespace, filename };
  if (bucketWritesEnabled()) {
    const res = await client().uploadFromFilename(bucketKey(loc), srcPath);
    if (!res.ok) {
      throw new Error(`Object storage upload failed: ${res.error.message}`);
    }
    cacheInvalidate(bucketKey(loc));
  } else {
    const dir = diskDir(namespace);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(srcPath, diskPath(loc));
  }
  return loc;
}

/**
 * Result of a delete attempt. `ok` is true when the live object is gone from
 * every backend (removed, or already absent) — i.e. the delete left storage in
 * the intended state. `ok` is false when a live copy could NOT be safely removed
 * (e.g. a soft-delete trash copy failed, so the live object was intentionally
 * left intact) — callers should surface this rather than swallow it. `error`
 * carries a short reason when `ok` is false. `deleteObject` never throws for a
 * storage-level failure; the failure is reported via this result.
 */
export interface DeleteResult {
  ok: boolean;
  error?: string;
}

/**
 * Delete an object. Soft-delete (default) moves it to a `trash/` prefix so it
 * can be recovered within the retention window before the cleanup sweep purges
 * it. Hard delete removes it immediately. Missing objects count as success.
 *
 * The object may live in both the bucket and on disk (dual backend); the result
 * is `ok` only when the live copy was cleared from every backend that has it, so
 * a caller can trust that a `ok:true` delete leaves no live object behind.
 */
export async function deleteObject(
  loc: StorageLocation,
  opts: { soft?: boolean } = {},
): Promise<DeleteResult> {
  if (!isSafeFilename(loc.filename)) return { ok: false, error: "unsafe filename" };
  const soft = opts.soft !== false;
  const key = bucketKey(loc);
  cacheInvalidate(key);

  let ok = true;
  let error: string | undefined;
  const fail = (reason: string) => {
    ok = false;
    error = error ?? reason;
  };

  if (OBJECT_STORAGE_CONFIGURED) {
    try {
      const exists = await client().exists(key);
      if (!exists.ok) {
        logger.error({ key, err: exists.error }, "Object storage exists check failed");
        fail("bucket exists check failed");
      } else if (exists.value) {
        if (soft) {
          const trashKey = TRASH_PREFIX + key;
          const copied = await client().copy(key, trashKey);
          if (!copied.ok) {
            // Recoverability is non-negotiable: if we could not stage a trash
            // copy, leave the live object in place rather than destroying it.
            logger.error(
              { key, err: copied.error },
              "Soft-delete copy to trash failed; leaving live object intact",
            );
            fail("trash copy failed");
          } else {
            const del = await client().delete(key, { ignoreNotFound: true });
            if (!del.ok) {
              logger.error({ key, err: del.error }, "Object storage delete failed after trash copy");
              fail("bucket delete failed");
            }
          }
        } else {
          const del = await client().delete(key, { ignoreNotFound: true });
          if (!del.ok) {
            logger.error({ key, err: del.error }, "Object storage delete failed");
            fail("bucket delete failed");
          }
        }
      }
    } catch (err) {
      logger.error({ err, key }, "Object storage delete failed");
      fail("bucket delete threw");
    }
  }

  const st = await diskStat(loc);
  if (st) {
    try {
      if (soft) {
        const trashDir = path.join(UPLOAD_ROOT, "trash", NAMESPACES[loc.namespace].bucketPrefix);
        await fsp.mkdir(trashDir, { recursive: true });
        await fsp.rename(st.path, path.join(trashDir, loc.filename)).catch(async () => {
          await fsp.copyFile(st.path, path.join(trashDir, loc.filename));
          await fsp.unlink(st.path);
        });
      } else {
        await fsp.unlink(st.path);
      }
    } catch (err) {
      logger.error({ err, loc }, "Disk delete failed");
      fail("disk delete failed");
    }
  }

  return { ok, error };
}

// ---------------------------------------------------------------------------
// HTTP serving with Range / conditional support
// ---------------------------------------------------------------------------

interface ServeOptions {
  /** Force a download disposition with the given filename. */
  downloadAs?: string;
}

function parseRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  let start: number;
  let end: number;
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    // suffix range: last N bytes
    const suffix = parseInt(endStr, 10);
    if (Number.isNaN(suffix)) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : parseInt(endStr, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

function applyCommonHeaders(res: Response, filename: string, contentType: string, opts: ServeOptions): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Accept-Ranges", "bytes");
  if (opts.downloadAs) {
    res.setHeader("Content-Disposition", `attachment; filename="${opts.downloadAs}"`);
  } else if (!isInlineType(contentType)) {
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filename)}"`);
  }
}

/**
 * Serve a stored object over HTTP with Range (206), conditional (304 via ETag),
 * and correct content-type headers. Streams from disk when possible; downloads
 * (and slices) from the bucket otherwise. Responds 404 when neither backend has
 * the object. Returns true if a response was sent.
 */
export async function serveStored(
  loc: StorageLocation,
  req: Request,
  res: Response,
  opts: ServeOptions = {},
): Promise<void> {
  if (!isSafeFilename(loc.filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  const contentType = contentTypeFor(loc.filename);

  // Prefer disk streaming when the file is on disk and bucket isn't the primary,
  // to avoid loading large files fully into memory.
  const preferDisk = !bucketWritesEnabled();
  if (preferDisk) {
    const st = await diskStat(loc);
    if (st) {
      serveFromDisk(st, loc.filename, contentType, req, res, opts);
      return;
    }
  }

  // Bucket path (or disk-primary miss). Prefer a TRUE ranged read so large
  // media (e.g. video scrubbing) streams only the requested bytes from the
  // bucket instead of pulling the whole object into memory. A bucket failure
  // must never escape this function: one bad object/SDK hiccup would otherwise
  // become an unhandled rejection and take down the whole process.
  if (OBJECT_STORAGE_CONFIGURED) {
    try {
      const served = await serveFromBucket(loc, contentType, req, res, opts);
      if (served) return;
    } catch (err) {
      logger.error({ err, loc }, "Bucket serve failed — falling back to disk");
      if (res.headersSent) {
        // Headers already went out for the bucket attempt; we cannot cleanly
        // switch to the disk file mid-response. Terminate this response only.
        res.destroy();
        return;
      }
    }
  }

  // Bucket miss (or backend not configured): fall back to disk if present.
  const st = await diskStat(loc);
  if (st) {
    serveFromDisk(st, loc.filename, contentType, req, res, opts);
    return;
  }

  res.status(404).json({ error: "File not found" });
}

/** Total size + a stable ETag for a bucket object, without downloading it. */
interface BucketObjectMeta {
  size: number;
  etag: string;
}

async function bucketMetadata(loc: StorageLocation): Promise<BucketObjectMeta | null> {
  // The @replit/object-storage Client wraps a @google-cloud/storage Bucket and
  // exposes it via getBucket(). The public type omits it, so probe defensively
  // and fall back (to a full download) when it is unavailable.
  const c = client() as unknown as {
    getBucket?: () => Promise<{
      file: (k: string) => {
        getMetadata: () => Promise<
          [{ size?: string | number; etag?: string; md5Hash?: string; generation?: string | number }]
        >;
      };
    }>;
  };
  if (typeof c.getBucket !== "function") return null;
  try {
    const bucket = await c.getBucket();
    const [md] = await bucket.file(bucketKey(loc)).getMetadata();
    const size = Number(md.size);
    if (!Number.isFinite(size)) return null;
    const tag = String(md.md5Hash ?? md.etag ?? md.generation ?? size);
    return { size, etag: `"${tag}"` };
  } catch {
    // Not found, or metadata unsupported — signal caller to fall back.
    return null;
  }
}

type RangedDownloadOptions = { start?: number; end?: number };

/**
 * Open a (optionally byte-ranged) read stream against the bucket.
 *
 * MUST be invoked as a method on the client (never pulled off as a bare
 * function reference): the SDK's downloadAsStream calls `this.getBucket()`
 * internally, so an unbound call throws and — being uncaught — used to kill
 * the whole process on the first image request. The SDK passes options
 * straight through to GCS `createReadStream`, which honors `start`/`end`,
 * so true ranged reads work even though the public type omits them.
 */
function bucketStream(loc: StorageLocation, range: { start: number; end: number } | null): Readable {
  const key = bucketKey(loc);
  const opts: RangedDownloadOptions | undefined = range ? { start: range.start, end: range.end } : undefined;
  return client().downloadAsStream(key, opts as Parameters<ObjectStorageClient["downloadAsStream"]>[1]);
}

function pipeBucketStream(stream: Readable, res: Response): void {
  stream.on("error", (err) => {
    logger.error({ err }, "Bucket stream failed");
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
}

/**
 * Serve a bucket object. Uses object metadata + a ranged read stream so seeks
 * transfer only the requested bytes. Returns false (without sending) when the
 * object is absent so the caller can try the disk fallback. Falls back to a
 * full buffered read when the SDK does not expose ranged metadata/streaming.
 */
async function serveFromBucket(
  loc: StorageLocation,
  contentType: string,
  req: Request,
  res: Response,
  opts: ServeOptions,
): Promise<boolean> {
  const meta = await bucketMetadata(loc);
  if (meta) {
    applyCommonHeaders(res, loc.filename, contentType, opts);
    res.setHeader("ETag", meta.etag);
    if (req.headers["if-none-match"] === meta.etag) {
      res.status(304).end();
      return true;
    }
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string") {
      const range = parseRange(rangeHeader, meta.size);
      if (!range) {
        res.status(416).setHeader("Content-Range", `bytes */${meta.size}`);
        res.end();
        return true;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${meta.size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
      pipeBucketStream(bucketStream(loc, range), res);
      return true;
    }
    res.status(200);
    res.setHeader("Content-Length", String(meta.size));
    pipeBucketStream(bucketStream(loc, null), res);
    return true;
  }

  // Legacy fallback: full (cached) download + in-memory slice.
  const buffer = await bucketDownload(loc);
  if (!buffer) return false;
  serveBuffer(buffer, loc, contentType, req, res, opts);
  return true;
}

/** Serve an already-in-memory buffer with ETag/304/Range/200 semantics. */
function serveBuffer(
  buffer: Buffer,
  loc: StorageLocation,
  contentType: string,
  req: Request,
  res: Response,
  opts: ServeOptions,
): void {
  const etag = `"${crypto.createHash("sha1").update(buffer).digest("hex")}"`;
  applyCommonHeaders(res, loc.filename, contentType, opts);
  res.setHeader("ETag", etag);

  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  const size = buffer.length;
  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === "string") {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    const slice = buffer.subarray(range.start, range.end + 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader("Content-Length", String(slice.length));
    res.end(slice);
    return;
  }

  res.status(200);
  res.setHeader("Content-Length", String(size));
  res.end(buffer);
}

function serveFromDisk(
  st: DiskStat,
  filename: string,
  contentType: string,
  req: Request,
  res: Response,
  opts: ServeOptions,
): void {
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  applyCommonHeaders(res, filename, contentType, opts);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", new Date(st.mtimeMs).toUTCString());

  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === "string") {
    const range = parseRange(rangeHeader, st.size);
    if (!range) {
      res.status(416).setHeader("Content-Range", `bytes */${st.size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${st.size}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    const stream = fs.createReadStream(st.path, { start: range.start, end: range.end });
    pipeWithErrorHandling(stream, res);
    return;
  }

  res.status(200);
  res.setHeader("Content-Length", String(st.size));
  pipeWithErrorHandling(fs.createReadStream(st.path), res);
}

function pipeWithErrorHandling(stream: Readable, res: Response): void {
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// Helpers for scripts (backfill / reconcile / cleanup)
// ---------------------------------------------------------------------------

export const internal = {
  NAMESPACES,
  UPLOAD_ROOT,
  TRASH_PREFIX,
  bucketKey,
  diskPath,
  diskDir,
  client,
  isSafeFilename,
};

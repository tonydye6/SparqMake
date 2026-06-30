import fs from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";
import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeAll } from "vitest";

// Disk backend, isolated temp uploads tree (UPLOAD_ROOT resolves from cwd at load).
delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
process.env.STORAGE_BACKEND = "disk";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
process.chdir(TMP);

// Control the ownership gate without a database.
const isFileReferenced = vi.fn<(loc: unknown) => Promise<boolean>>();
vi.mock("../services/file-ownership.js", () => ({ isFileReferenced }));

const { serveOwnedFile } = await import("./upload.js");
const storage = await import("../services/storage.js");

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  jsonBody: unknown = undefined;
  private chunks: Buffer[] = [];
  status(code: number): this { this.statusCode = code; return this; }
  setHeader(k: string, v: string | number): this { this.headers[k.toLowerCase()] = String(v); return this; }
  getHeader(k: string): string | undefined { return this.headers[k.toLowerCase()]; }
  json(obj: unknown): this { this.jsonBody = obj; this.emit("finish"); return this; }
  get headersSent(): boolean { return false; }
  _write(chunk: Buffer, _enc: string, cb: () => void): void { this.chunks.push(Buffer.from(chunk)); cb(); }
  getBody(): Buffer { return Buffer.concat(this.chunks); }
}

function reqFor(filename: string): Request {
  return { params: { filename }, headers: {} } as unknown as Request;
}

async function run(namespace: "uploads" | "brand-assets" | "assets", filename: string) {
  const res = new MockResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await serveOwnedFile(namespace, reqFor(filename), res as unknown as Response);
  await finished;
  return res;
}

describe("serveOwnedFile ownership gate", () => {
  beforeAll(async () => {
    // A real file on disk, so a denial is the gate's decision, not a missing file.
    await storage.writeBuffer("uploads", "owned.png", Buffer.from("\x89PNG owned bytes"));
  });

  it("denies (404) a file no DB row references — even though the bytes exist", async () => {
    isFileReferenced.mockResolvedValue(false);
    const res = await run("uploads", "owned.png");
    expect(res.statusCode).toBe(404);
  });

  it("serves (200) a file a DB row references", async () => {
    isFileReferenced.mockResolvedValue(true);
    const res = await run("uploads", "owned.png");
    expect(res.statusCode).toBe(200);
    expect(res.getBody().length).toBeGreaterThan(0);
  });

  it("denies (404) referenced-but-missing bytes", async () => {
    isFileReferenced.mockResolvedValue(true);
    const res = await run("uploads", "ghost.png");
    expect(res.statusCode).toBe(404);
  });
});

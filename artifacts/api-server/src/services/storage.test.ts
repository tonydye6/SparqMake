import fs from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";
import type { Request, Response } from "express";
import { describe, it, expect, beforeAll } from "vitest";
import type { StorageLocation } from "./storage.js";

// Force the disk backend: tests run without a provisioned bucket. We chdir into
// a throwaway dir *before* importing storage so UPLOAD_ROOT (resolved at module
// load from cwd) points at our temp tree.
delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
process.env.STORAGE_BACKEND = "disk";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
process.chdir(TMP);

const storage = await import("./storage.js");

/** Minimal Express Response: a Writable that also records status/headers/json. */
class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  jsonBody: unknown = undefined;
  private chunks: Buffer[] = [];

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(key: string, value: string | number): this {
    this.headers[key.toLowerCase()] = String(value);
    return this;
  }
  getHeader(key: string): string | undefined {
    return this.headers[key.toLowerCase()];
  }
  json(obj: unknown): this {
    this.jsonBody = obj;
    this.emit("finish");
    return this;
  }
  get headersSent(): boolean {
    return false;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  getBody(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function mockReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower } as unknown as Request;
}

async function serve(loc: StorageLocation, req: Request) {
  const res = new MockResponse();
  const finished = new Promise<void>((resolve) => res.once("finish", resolve));
  await storage.serveStored(loc, req, res as unknown as Response);
  await finished;
  return res;
}

describe("resolveUrl / publicUrlFor", () => {
  it("maps each namespace prefix", () => {
    expect(storage.resolveUrl("/api/files/generated/x.png")).toEqual({ namespace: "generated", filename: "x.png" });
    expect(storage.resolveUrl("/api/files/brand-assets/logo.png")).toEqual({
      namespace: "brand-assets",
      filename: "logo.png",
    });
    expect(storage.resolveUrl("/api/files/assets/a.mp4")).toEqual({ namespace: "assets", filename: "a.mp4" });
    expect(storage.resolveUrl("/api/files/photo.jpg")).toEqual({ namespace: "uploads", filename: "photo.jpg" });
  });

  it("handles absolute URLs and rejects external / traversal", () => {
    expect(storage.resolveUrl("https://host.example/api/files/generated/x.png")).toEqual({
      namespace: "generated",
      filename: "x.png",
    });
    expect(storage.resolveUrl("https://external.com/img.png")).toBeNull();
    expect(storage.resolveUrl("/api/files/generated/../secret")).toBeNull();
    expect(storage.resolveUrl(null)).toBeNull();
  });

  it("round-trips through publicUrlFor", () => {
    for (const loc of [
      { namespace: "uploads", filename: "a.jpg" },
      { namespace: "generated", filename: "b.png" },
      { namespace: "brand-assets", filename: "c.woff2" },
      { namespace: "assets", filename: "d.mp4" },
    ] as const) {
      expect(storage.resolveUrl(storage.publicUrlFor(loc))).toEqual(loc);
    }
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions and defaults otherwise", () => {
    expect(storage.contentTypeFor("a.png")).toBe("image/png");
    expect(storage.contentTypeFor("a.mp4")).toBe("video/mp4");
    expect(storage.contentTypeFor("a.woff2")).toBe("font/woff2");
    expect(storage.contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("write + read round-trip (disk backend)", () => {
  it("writeBuffer then readBuffer returns identical bytes", async () => {
    const data = Buffer.from("hello world round trip");
    const loc = await storage.writeBuffer("generated", "roundtrip.bin", data);
    const read = await storage.readBuffer(loc);
    expect(read).not.toBeNull();
    expect(read!.equals(data)).toBe(true);
  });

  it("readBuffer returns null for a missing object", async () => {
    expect(await storage.readBuffer({ namespace: "generated", filename: "nope.bin" })).toBeNull();
  });

  it("rejects unsafe filenames on write", async () => {
    await expect(storage.writeBuffer("generated", "../evil", Buffer.from("x"))).rejects.toThrow();
  });
});

describe("deleteObject (soft-delete moves to trash, removes live copy)", () => {
  it("removes the live object and leaves a recoverable trash copy on disk", async () => {
    const data = Buffer.from("delete me softly");
    const loc = await storage.writeBuffer("generated", "to-delete.bin", data);
    expect(await storage.readBuffer(loc)).not.toBeNull();

    await storage.deleteObject(loc, { soft: true });

    // live copy gone
    expect(await storage.readBuffer(loc)).toBeNull();
    // trash copy present: <UPLOAD_ROOT>/trash/generated/to-delete.bin
    const trashPath = path.join(storage.internal.UPLOAD_ROOT, "trash", "generated", "to-delete.bin");
    expect(fs.existsSync(trashPath)).toBe(true);
    expect(fs.readFileSync(trashPath).equals(data)).toBe(true);
  });

  it("hard delete removes the object with no trash copy", async () => {
    const loc = await storage.writeBuffer("generated", "hard-delete.bin", Buffer.from("gone"));
    await storage.deleteObject(loc, { soft: false });
    expect(await storage.readBuffer(loc)).toBeNull();
    const trashPath = path.join(storage.internal.UPLOAD_ROOT, "trash", "generated", "hard-delete.bin");
    expect(fs.existsSync(trashPath)).toBe(false);
  });
});

describe("serveStored", () => {
  const body = Buffer.from("0123456789ABCDEFGHIJ"); // 20 bytes
  let loc: StorageLocation;

  beforeAll(async () => {
    loc = await storage.writeBuffer("generated", "serve.bin", body);
  });

  it("serves full content (200) with headers", async () => {
    const res = await serve(loc, mockReq());
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("accept-ranges")).toBe("bytes");
    expect(res.getHeader("content-length")).toBe(String(body.length));
    expect(res.getBody().equals(body)).toBe(true);
  });

  it("serves a byte range (206)", async () => {
    const res = await serve(loc, mockReq({ Range: "bytes=5-9" }));
    expect(res.statusCode).toBe(206);
    expect(res.getHeader("content-range")).toBe(`bytes 5-9/${body.length}`);
    expect(res.getBody().equals(body.subarray(5, 10))).toBe(true);
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const res = await serve(loc, mockReq({ Range: "bytes=999-1000" }));
    expect(res.statusCode).toBe(416);
    expect(res.getHeader("content-range")).toBe(`bytes */${body.length}`);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const first = await serve(loc, mockReq());
    const etag = first.getHeader("etag");
    expect(etag).toBeTruthy();
    const res = await serve(loc, mockReq({ "If-None-Match": etag! }));
    expect(res.statusCode).toBe(304);
  });

  it("returns 404 for a missing file", async () => {
    const res = await serve({ namespace: "generated", filename: "missing.bin" }, mockReq());
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for an unsafe filename", async () => {
    const res = await serve({ namespace: "generated", filename: "../escape" }, mockReq());
    expect(res.statusCode).toBe(400);
  });
});

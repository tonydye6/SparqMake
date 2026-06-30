import os from "os";
import path from "path";
import fs from "fs";
import { Readable, Writable } from "stream";
import type { Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const OBJECT = Buffer.from("0123456789ABCDEFGHIJ"); // 20 bytes
const calls = {
  downloadAsBytes: 0,
  stream: [] as Array<{ start?: number; end?: number } | undefined>,
  getMetadata: 0,
};

vi.mock("@replit/object-storage", () => {
  class Client {
    async getBucket() {
      return {
        file: (_k: string) => ({
          getMetadata: async () => {
            calls.getMetadata += 1;
            return [{ size: OBJECT.length, md5Hash: "deadbeef" }];
          },
        }),
      };
    }
    async exists(_k: string) {
      return { ok: true, value: true };
    }
    async downloadAsBytes(_k: string) {
      calls.downloadAsBytes += 1;
      return { ok: true, value: [OBJECT] };
    }
    // GCS createReadStream({start,end}) honors byte ranges; the wrapper passes
    // options straight through, so a true ranged read returns only those bytes.
    downloadAsStream(_k: string, opts?: { start?: number; end?: number }) {
      calls.stream.push(opts);
      const start = opts?.start ?? 0;
      const end = opts?.end ?? OBJECT.length - 1;
      return Readable.from([OBJECT.subarray(start, end + 1)]);
    }
  }
  return { Client };
});

process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
process.env.STORAGE_BACKEND = "bucket";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "storage-range-test-")));

const storage = await import("./storage.js");

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  setHeader(k: string, v: string | number): this {
    this.headers[k.toLowerCase()] = String(v);
    this.headersSent = true;
    return this;
  }
  getHeader(k: string): string | undefined {
    return this.headers[k.toLowerCase()];
  }
  json(): this {
    return this;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
  waitForFinish(): Promise<void> {
    return new Promise((resolve) => {
      if (this.writableFinished) resolve();
      else this.on("finish", () => resolve());
    });
  }
}

function makeReq(headers: Record<string, string> = {}) {
  return { headers } as unknown as Parameters<typeof storage.serveStored>[1];
}

describe("serveStored bucket ranged reads (no full download)", () => {
  const loc = { namespace: "generated", filename: "video.mp4" } as const;

  beforeEach(() => {
    calls.downloadAsBytes = 0;
    calls.stream = [];
    calls.getMetadata = 0;
  });

  it("serves a 206 streaming only the requested byte range, never a full download", async () => {
    const res = new MockResponse();
    await storage.serveStored(loc, makeReq({ range: "bytes=5-9" }), res as unknown as Response);
    await res.waitForFinish();

    expect(res.statusCode).toBe(206);
    expect(res.getHeader("content-range")).toBe("bytes 5-9/20");
    expect(res.getHeader("content-length")).toBe("5");
    expect(res.body.toString()).toBe("56789");
    // True ranged read: stream opened with start/end, full download never used.
    expect(calls.stream).toEqual([{ start: 5, end: 9 }]);
    expect(calls.downloadAsBytes).toBe(0);
  });

  it("serves a full 200 via stream (not a buffered download) and advertises size", async () => {
    const res = new MockResponse();
    await storage.serveStored(loc, makeReq(), res as unknown as Response);
    await res.waitForFinish();

    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-length")).toBe("20");
    expect(res.getHeader("accept-ranges")).toBe("bytes");
    expect(res.body.equals(OBJECT)).toBe(true);
    expect(calls.stream).toEqual([undefined]);
    expect(calls.downloadAsBytes).toBe(0);
  });

  it("returns 416 for an unsatisfiable range without downloading bytes", async () => {
    const res = new MockResponse();
    await storage.serveStored(loc, makeReq({ range: "bytes=999-1000" }), res as unknown as Response);
    await res.waitForFinish();

    expect(res.statusCode).toBe(416);
    expect(res.getHeader("content-range")).toBe("bytes */20");
    expect(calls.stream).toEqual([]);
    expect(calls.downloadAsBytes).toBe(0);
  });

  it("honors conditional requests (304) using metadata ETag, no body download", async () => {
    const first = new MockResponse();
    await storage.serveStored(loc, makeReq(), first as unknown as Response);
    await first.waitForFinish();
    const etag = first.getHeader("etag");
    expect(etag).toBeDefined();

    // Reset after the warm-up request: only the conditional request matters here.
    calls.stream = [];
    calls.downloadAsBytes = 0;

    const res = new MockResponse();
    await storage.serveStored(loc, makeReq({ "if-none-match": etag as string }), res as unknown as Response);
    await res.waitForFinish();
    expect(res.statusCode).toBe(304);
    expect(calls.stream).toEqual([]);
    expect(calls.downloadAsBytes).toBe(0);
  });
});

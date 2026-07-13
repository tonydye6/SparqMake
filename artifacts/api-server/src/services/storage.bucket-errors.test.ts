import os from "os";
import path from "path";
import fs from "fs";
import { Readable, Writable } from "stream";
import type { Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression suite for the serve-path crash class: any failure while opening
// or piping a bucket stream (unbound SDK method, SDK throw, stream error) must
// produce an error response for THAT request only — never an unhandled
// throw/rejection that kills the server process. Also covers the clean-404
// path when an object is missing from both bucket and disk.

const OBJECT = Buffer.from("0123456789ABCDEFGHIJ"); // 20 bytes

type Behavior = "ok" | "throw-sync" | "stream-error" | "missing";
const state: { behavior: Behavior } = { behavior: "ok" };

vi.mock("@replit/object-storage", () => {
  class Client {
    async getBucket() {
      return {
        file: (_k: string) => ({
          getMetadata: async () => {
            if (state.behavior === "missing") throw new Error("No such object");
            return [{ size: OBJECT.length, md5Hash: "cafebabe" }];
          },
        }),
      };
    }
    async exists(_k: string) {
      return { ok: true, value: state.behavior !== "missing" };
    }
    async downloadAsBytes(_k: string) {
      if (state.behavior === "missing") return { ok: false, error: { message: "not found" } };
      return { ok: true, value: [OBJECT] };
    }
    downloadAsStream(_k: string, _opts?: { start?: number; end?: number }) {
      // Real SDK dereferences `this`; an unbound call must throw like prod.
      if (this === undefined || typeof (this as Client).getBucket !== "function") {
        throw new TypeError("Cannot read properties of undefined (reading 'getBucket')");
      }
      if (state.behavior === "throw-sync") {
        throw new TypeError("Cannot read properties of undefined (reading 'getBucket')");
      }
      if (state.behavior === "stream-error") {
        const r = new Readable({ read() { /* error emitted async below */ } });
        setImmediate(() => r.emit("error", new Error("stream request failed")));
        return r;
      }
      return Readable.from([OBJECT]);
    }
  }
  return { Client };
});

process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
process.env.STORAGE_BACKEND = "bucket";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "storage-errors-test-")));

const storage = await import("./storage.js");

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyedByHandler = false;
  jsonBody: unknown = undefined;
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
  json(obj: unknown): this {
    this.jsonBody = obj;
    this.emit("finish");
    return this;
  }
  override destroy(): this {
    this.destroyedByHandler = true;
    this.emit("finish");
    return this;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
  waitForFinish(timeoutMs = 1000): Promise<void> {
    return new Promise((resolve) => {
      if (this.writableFinished) return resolve();
      const t = setTimeout(resolve, timeoutMs);
      this.on("finish", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

function makeReq(headers: Record<string, string> = {}) {
  return { headers } as unknown as Parameters<typeof storage.serveStored>[1];
}

const loc = { namespace: "generated", filename: "take.png" } as const;

describe("serveStored bucket failure hardening (process must survive)", () => {
  beforeEach(() => {
    state.behavior = "ok";
  });

  it("a synchronous SDK throw while opening the stream never escapes serveStored", async () => {
    state.behavior = "throw-sync";
    const res = new MockResponse();
    // The old unbound-call bug threw out of serveStored → unhandled rejection
    // → process exit. The promise must now always resolve.
    await expect(
      storage.serveStored(loc, makeReq(), res as unknown as Response),
    ).resolves.toBeUndefined();
    await res.waitForFinish();
    // Headers were already sent by the bucket attempt, so the only safe move
    // is terminating this one response (never the process).
    expect(res.destroyedByHandler).toBe(true);
  });

  it("an async stream error after headers terminates only that response", async () => {
    state.behavior = "stream-error";
    const res = new MockResponse();
    await storage.serveStored(loc, makeReq(), res as unknown as Response);
    await res.waitForFinish();
    expect(res.destroyedByHandler).toBe(true);
  });

  it("still serves normally when the SDK behaves (method called bound)", async () => {
    const res = new MockResponse();
    await storage.serveStored(loc, makeReq(), res as unknown as Response);
    await res.waitForFinish();
    expect(res.statusCode).toBe(200);
    expect(res.body.equals(OBJECT)).toBe(true);
  });

  it("returns a clean 404 when the object is missing from bucket AND disk", async () => {
    state.behavior = "missing";
    const res = new MockResponse();
    await storage.serveStored(
      { namespace: "generated", filename: "long-gone.png" },
      makeReq(),
      res as unknown as Response,
    );
    await res.waitForFinish();
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: "File not found" });
  });
});

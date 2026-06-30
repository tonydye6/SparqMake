import os from "os";
import path from "path";
import fs from "fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track calls made to the mocked Object Storage client.
const calls = { copy: [] as Array<[string, string]>, delete: [] as string[] };
let copyShouldFail = false;

vi.mock("@replit/object-storage", () => {
  class Client {
    async exists(_key: string) {
      return { ok: true, value: true };
    }
    async copy(from: string, to: string) {
      calls.copy.push([from, to]);
      return copyShouldFail
        ? { ok: false, error: { message: "boom" } }
        : { ok: true, value: undefined };
    }
    async delete(key: string) {
      calls.delete.push(key);
      return { ok: true, value: undefined };
    }
  }
  return { Client };
});

// Provision a bucket + force the bucket backend BEFORE importing storage.
process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
process.env.STORAGE_BACKEND = "bucket";
// chdir somewhere with no uploads/ tree so the disk branch is a no-op.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "storage-bucket-test-")));

const storage = await import("./storage.js");

describe("deleteObject soft-delete recoverability (bucket backend)", () => {
  beforeEach(() => {
    calls.copy = [];
    calls.delete = [];
    copyShouldFail = false;
  });

  it("does NOT delete the live object when the trash copy fails", async () => {
    copyShouldFail = true;
    await storage.deleteObject({ namespace: "generated", filename: "x.png" }, { soft: true });

    expect(calls.copy).toHaveLength(1);
    expect(calls.copy[0]).toEqual(["generated/x.png", "trash/generated/x.png"]);
    expect(calls.delete).toHaveLength(0); // live object left intact — recoverable
  });

  it("deletes the live object only after the trash copy succeeds", async () => {
    copyShouldFail = false;
    await storage.deleteObject({ namespace: "generated", filename: "y.png" }, { soft: true });

    expect(calls.copy).toHaveLength(1);
    expect(calls.delete).toEqual(["generated/y.png"]);
  });

  it("hard delete removes the object without staging a trash copy", async () => {
    await storage.deleteObject({ namespace: "generated", filename: "z.png" }, { soft: false });

    expect(calls.copy).toHaveLength(0);
    expect(calls.delete).toEqual(["generated/z.png"]);
  });
});

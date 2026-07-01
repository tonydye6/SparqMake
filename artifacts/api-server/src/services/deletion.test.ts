import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the storage layer so the deletion service is exercised in isolation:
// resolveUrl maps a public URL to a storage location, deleteObject reports the
// per-object result the service must aggregate.
const resolveUrl = vi.fn<(url: string) => unknown>();
const deleteObject = vi.fn<(loc: unknown) => Promise<{ ok: boolean; error?: string }>>();
vi.mock("./storage.js", () => ({ resolveUrl, deleteObject }));

const { softDeleteBackingObjects, MAX_BULK_DELETE } = await import("./deletion.js");

function locFor(url: string) {
  return { namespace: "assets", filename: url.split("/").pop() };
}

beforeEach(() => {
  resolveUrl.mockReset();
  deleteObject.mockReset();
  resolveUrl.mockImplementation((url: string) => locFor(url));
  deleteObject.mockResolvedValue({ ok: true });
});

describe("softDeleteBackingObjects", () => {
  it("soft-deletes every resolvable url and reports them as removed", async () => {
    const urls = ["/api/files/assets/a.png", "/api/files/assets/b.png"];
    const r = await softDeleteBackingObjects(urls);
    expect(r.removed).toEqual(urls);
    expect(r.failed).toEqual([]);
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it("reports partial failure without throwing (storage errors are surfaced, not swallowed)", async () => {
    deleteObject.mockImplementation(async (loc) =>
      (loc as { filename: string }).filename === "b.png"
        ? { ok: false, error: "trash copy failed" }
        : { ok: true },
    );
    const r = await softDeleteBackingObjects(["/api/files/assets/a.png", "/api/files/assets/b.png"]);
    expect(r.removed).toEqual(["/api/files/assets/a.png"]);
    expect(r.failed).toEqual(["/api/files/assets/b.png"]);
  });

  it("skips null/undefined and unresolvable (external) urls", async () => {
    resolveUrl.mockImplementation((url: string) => (url.startsWith("/api/files/") ? locFor(url) : null));
    const r = await softDeleteBackingObjects([
      null,
      undefined,
      "https://cdn.example.com/x.png",
      "/api/files/assets/a.png",
    ]);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(r.removed).toEqual(["/api/files/assets/a.png"]);
    expect(r.failed).toEqual([]);
  });

  it("de-duplicates the same backing object so it is only deleted once", async () => {
    const r = await softDeleteBackingObjects(["/api/files/assets/a.png", "/api/files/assets/a.png"]);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(r.removed).toEqual(["/api/files/assets/a.png"]);
  });
});

describe("MAX_BULK_DELETE", () => {
  it("is a positive integer cap", () => {
    expect(Number.isInteger(MAX_BULK_DELETE)).toBe(true);
    expect(MAX_BULK_DELETE).toBeGreaterThan(0);
  });
});

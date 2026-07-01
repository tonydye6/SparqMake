import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Dev-auth bypass so importing the auth middleware never hits a real DB.
process.env.DEV_AUTH_BYPASS = "true";

// --- Table sentinels -------------------------------------------------------
const assetsTable = { __name: "assets" };
const creativesTable = { __name: "creatives" };

// --- Configurable per-test DB results --------------------------------------
let deleteReturn: Array<Record<string, unknown>> = [];

function selectChain() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
  };
  return chain;
}

const db = {
  insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
  delete: () => ({ where: () => ({ returning: () => Promise.resolve(deleteReturn) }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  select: () => selectChain(),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
};

vi.mock("@workspace/db", () => ({ db, assetsTable, creativesTable }));

const op = () => ({});
vi.mock("drizzle-orm", () => ({
  eq: op, ne: op, and: op, or: op, inArray: op, ilike: op, desc: op,
  arrayContains: op, sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

// Control the storage layer that the real deletion service calls.
const resolveUrl = vi.fn<(url: string) => unknown>();
const deleteObject = vi.fn<(loc: unknown) => Promise<{ ok: boolean; error?: string }>>();
vi.mock("../services/storage.js", () => ({ resolveUrl, deleteObject }));

// Backfill service is irrelevant here; stub so importing assets.js is cheap.
vi.mock("../services/backfill-assets.js", () => ({ backfillAssetClassifications: vi.fn() }));

const assetsRouter = (await import("./assets.js")).default;
const { MAX_BULK_DELETE } = await import("../services/deletion.js");

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
}
function getHandler(
  router: { stack: RouteLayer[] },
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  const layer = (router.stack as RouteLayer[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method] === true,
  );
  if (!layer?.route) throw new Error(`route not found: ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: Request, res: Response) => Promise<void>;
}

function mockReq(over: Record<string, unknown>): Request {
  return { body: {}, params: {}, query: {}, user: { id: "admin-1", role: "admin" }, ...over } as unknown as Request;
}

interface CapturingRes {
  statusCode: number;
  body: Record<string, unknown> | undefined;
  status: (c: number) => CapturingRes;
  json: (b: unknown) => CapturingRes;
}
function mockRes(): CapturingRes {
  const res: CapturingRes = {
    statusCode: 200,
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b as Record<string, unknown>; return res; },
  };
  return res;
}

beforeEach(() => {
  deleteReturn = [];
  resolveUrl.mockReset();
  deleteObject.mockReset();
  resolveUrl.mockImplementation((url: string) => ({ namespace: "assets", filename: url.split("/").pop() }));
  deleteObject.mockResolvedValue({ ok: true });
});

describe("POST /assets/bulk-delete", () => {
  const bulkDelete = () => getHandler(assetsRouter as never, "post", "/assets/bulk-delete");

  it("rejects (400) an empty ids array", async () => {
    const res = mockRes();
    await bulkDelete()(mockReq({ body: { ids: [] } }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it("enforces the batch cap (400) when more than MAX_BULK_DELETE unique ids are sent", async () => {
    const ids = Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => `id-${i}`);
    const res = mockRes();
    await bulkDelete()(mockReq({ body: { ids } }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(String(res.body?.error)).toContain(String(MAX_BULK_DELETE));
    // The DB delete must never run when the cap is exceeded.
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("does NOT count duplicate ids against the cap", async () => {
    // MAX+1 raw ids but only 1 unique → allowed.
    const ids = Array.from({ length: MAX_BULK_DELETE + 1 }, () => "dupe");
    deleteReturn = [{ id: "dupe", fileUrl: "/api/files/assets/a.png", thumbnailUrl: null }];
    const res = mockRes();
    await bulkDelete()(mockReq({ body: { ids } }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body?.deleted).toBe(1);
  });

  it("reports deleted count, deletedIds, and notFound ids", async () => {
    deleteReturn = [
      { id: "a1", fileUrl: "/api/files/assets/a1.png", thumbnailUrl: null },
      { id: "a2", fileUrl: "/api/files/assets/a2.png", thumbnailUrl: null },
    ];
    const res = mockRes();
    await bulkDelete()(mockReq({ body: { ids: ["a1", "a2", "missing"] } }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body?.deleted).toBe(2);
    expect(res.body?.deletedIds).toEqual(["a1", "a2"]);
    expect(res.body?.notFound).toEqual(["missing"]);
    expect(res.body?.storageCleanupFailed).toEqual([]);
  });

  it("surfaces partial storage-cleanup failure instead of swallowing it", async () => {
    deleteReturn = [
      { id: "a1", fileUrl: "/api/files/assets/a1.png", thumbnailUrl: null },
      { id: "a2", fileUrl: "/api/files/assets/a2.png", thumbnailUrl: null },
    ];
    deleteObject.mockImplementation(async (loc) =>
      (loc as { filename: string }).filename === "a2.png"
        ? { ok: false, error: "trash copy failed" }
        : { ok: true },
    );
    const res = mockRes();
    await bulkDelete()(mockReq({ body: { ids: ["a1", "a2"] } }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body?.deleted).toBe(2);
    expect(res.body?.storageCleanupFailed).toEqual(["/api/files/assets/a2.png"]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.STORAGE_BACKEND = "disk";
delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;

// Column markers so we can inspect which columns a query predicate references.
const assetsTable = { id: "assets.id", fileUrl: "assets.fileUrl", thumbnailUrl: "assets.thumbnailUrl" };
const brandsTable = { id: "brands.id", logoFileUrl: "brands.logoFileUrl", brandFonts: "brands.brandFonts" };
const creativesTable = { id: "creatives.id", referenceScreenshots: "creatives.referenceScreenshots" };
const creativeVariantsTable = {
  id: "cv.id",
  rawImageUrl: "cv.rawImageUrl",
  compositedImageUrl: "cv.compositedImageUrl",
  videoUrl: "cv.videoUrl",
  audioUrl: "cv.audioUrl",
  mergedVideoUrl: "cv.mergedVideoUrl",
};

// Each query resolves through this matcher; tests swap it per scenario.
let matcher: (table: unknown, cond: unknown) => Array<{ id: string }> = () => [];

vi.mock("@workspace/db", () => ({
  assetsTable,
  brandsTable,
  creativesTable,
  creativeVariantsTable,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          limit: () => Promise.resolve(matcher(table, cond)),
        }),
      }),
    }),
  },
}));

// Make predicate trees inspectable instead of opaque SQL objects.
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ kind: "eq", col, val }),
  or: (...conds: unknown[]) => ({ kind: "or", conds }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ kind: "sql", strings: [...strings], vals }),
}));

const { isFileReferenced } = await import("./file-ownership.js");

/** Flatten an eq/or predicate tree into its leaf (col,val) equality nodes. */
function eqLeaves(cond: unknown): Array<{ col: unknown; val: unknown }> {
  if (!cond || typeof cond !== "object") return [];
  const node = cond as { kind?: string; col?: unknown; val?: unknown; conds?: unknown[] };
  if (node.kind === "eq") return [{ col: node.col, val: node.val }];
  if (node.kind === "or" && Array.isArray(node.conds)) return node.conds.flatMap(eqLeaves);
  return [];
}

function condChecks(cond: unknown, col: unknown, val: unknown): boolean {
  return eqLeaves(cond).some((l) => l.col === col && l.val === val);
}

describe("isFileReferenced (asset thumbnail authorization)", () => {
  beforeEach(() => {
    matcher = () => [];
  });

  it("authorizes an asset referenced only via thumbnailUrl (regression)", async () => {
    const url = "/api/files/assets/thumb.png";
    matcher = (table, cond) =>
      table === assetsTable && condChecks(cond, assetsTable.thumbnailUrl, url) ? [{ id: "a1" }] : [];

    const allowed = await isFileReferenced({ namespace: "assets", filename: "thumb.png" });
    expect(allowed).toBe(true);
  });

  it("still authorizes an asset referenced via fileUrl", async () => {
    const url = "/api/files/assets/main.png";
    matcher = (table, cond) =>
      table === assetsTable && condChecks(cond, assetsTable.fileUrl, url) ? [{ id: "a2" }] : [];

    expect(await isFileReferenced({ namespace: "assets", filename: "main.png" })).toBe(true);
  });

  it("denies an asset key no row references", async () => {
    matcher = () => [];
    expect(await isFileReferenced({ namespace: "assets", filename: "orphan.png" })).toBe(false);
  });
});

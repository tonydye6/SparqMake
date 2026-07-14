import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateAssetBody } from "@workspace/api-zod";

// Dev-auth bypass so importing the auth middleware never hits a real DB.
process.env.DEV_AUTH_BYPASS = "true";

// --- Table sentinels -------------------------------------------------------
const assetsTable = { __name: "assets" };
const creativesTable = { __name: "creatives" };

// --- Configurable per-test DB results --------------------------------------
let insertedValues: Record<string, unknown> | undefined;

const db = {
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      insertedValues = v;
      return {
        returning: () =>
          Promise.resolve([
            {
              id: "asset-1",
              brandId: v.brandId,
              type: v.type,
              subType: null,
              status: (v.status as string) ?? "uploaded",
              name: v.name,
              description: null,
              tags: v.tags ?? [],
              fileUrl: v.fileUrl ?? null,
              thumbnailUrl: v.thumbnailUrl ?? null,
              content: null,
              mimeType: v.mimeType ?? null,
              fileSizeBytes: v.fileSizeBytes ?? null,
              uploadedBy: v.uploadedBy,
              approvedBy: null,
              approvedAt: null,
              usageCount: 0,
              assetClass: null,
              generationRole: null,
              brandLayer: null,
              franchise: null,
              conflictTags: [],
              approvedChannels: [],
              approvedTemplates: [],
              compositingOnly: false,
              generationAllowed: true,
              approvedForCompositing: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
      };
    },
  }),
  delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
  update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  select: () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
    };
    return chain;
  },
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
};

vi.mock("@workspace/db", () => ({ db, assetsTable, creativesTable }));

const op = () => ({});
vi.mock("drizzle-orm", () => ({
  eq: op, ne: op, and: op, or: op, inArray: op, ilike: op, desc: op,
  arrayContains: op, sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

vi.mock("../services/storage.js", () => ({ resolveUrl: vi.fn(), deleteObject: vi.fn() }));
vi.mock("../services/backfill-assets.js", () => ({ backfillAssetClassifications: vi.fn() }));

const assetsRouter = (await import("./assets.js")).default;

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
  return { body: {}, params: {}, query: {}, user: { id: "user-42", role: "editor" }, ...over } as unknown as Request;
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
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b as Record<string, unknown>;
      return res;
    },
  };
  return res;
}

// The exact payload AssetLibrary.tsx sends after a file upload — no uploadedBy.
const uploadPayload = {
  brandId: "brand-1",
  type: "visual",
  name: "logo.png",
  status: "uploaded",
  fileUrl: "/api/files/abc.png",
  thumbnailUrl: "/api/files/abc.png",
  mimeType: "image/png",
  fileSizeBytes: 12345,
  tags: [],
};

// The exact payload AssetLibrary.tsx sends when creating a brief.
const briefPayload = {
  brandId: "brand-1",
  type: "context",
  name: "Summer campaign brief",
  content: "Tone: energetic",
  status: "approved",
  tags: ["summer"],
};

describe("CreateAssetBody validation (regression: uploads failed with 400)", () => {
  it("accepts the file-upload payload without uploadedBy", () => {
    const result = CreateAssetBody.safeParse(uploadPayload);
    expect(result.success).toBe(true);
  });

  it("accepts the brief payload without uploadedBy and keeps status", () => {
    const result = CreateAssetBody.safeParse(briefPayload);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe("approved");
  });

  it("rejects an invalid status value", () => {
    const result = CreateAssetBody.safeParse({ ...uploadPayload, status: "bogus" });
    expect(result.success).toBe(false);
  });
});

describe("POST /assets handler", () => {
  beforeEach(() => {
    insertedValues = undefined;
  });

  it("sets uploadedBy from the authenticated user, returns 201", async () => {
    const handler = getHandler(assetsRouter as never, "post", "/assets");
    const parsed = CreateAssetBody.parse(uploadPayload);
    const res = mockRes();
    await handler(mockReq({ body: parsed }), res as unknown as Response);
    expect(res.statusCode).toBe(201);
    expect(insertedValues?.uploadedBy).toBe("user-42");
    expect((res.body as Record<string, unknown>).uploadedBy).toBe("user-42");
  });

  it("ignores a client-supplied uploadedBy", async () => {
    const handler = getHandler(assetsRouter as never, "post", "/assets");
    const res = mockRes();
    await handler(
      mockReq({ body: { ...CreateAssetBody.parse(uploadPayload), uploadedBy: "attacker" } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(201);
    expect(insertedValues?.uploadedBy).toBe("user-42");
  });

  it("preserves the requested status on insert", async () => {
    const handler = getHandler(assetsRouter as never, "post", "/assets");
    const res = mockRes();
    await handler(mockReq({ body: CreateAssetBody.parse(briefPayload) }), res as unknown as Response);
    expect(res.statusCode).toBe(201);
    expect(insertedValues?.status).toBe("approved");
  });
});

import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Enable the dev-auth bypass before any route/auth module loads so importing
// them never triggers a real DB round-trip (mirrors mutation-policy.test.ts).
process.env.DEV_AUTH_BYPASS = "true";

// --- Table sentinels -------------------------------------------------------
// Identity-only markers so the db mock can tell which table a query targets.
const auditLogsTable = { __name: "audit_logs" };
const assetsTable = { __name: "assets" };
const brandsTable = { __name: "brands" };
const appSettingsTable = { __name: "app_settings" };
const socialAccountsTable = { __name: "social_accounts" };
const costLogsTable = { __name: "cost_logs" };
const creativesTable = { __name: "creatives" };
const creativeVariantsTable = { __name: "creative_variants" };
const calendarEntriesTable = { __name: "calendar_entries" };
const socialContentPlanItemsTable = { __name: "social_content_plan_items" };
const hashtagSetsTable = { __name: "hashtag_sets" };
const templatesTable = { __name: "templates" };

// --- Configurable per-test results -----------------------------------------
let deleteReturn: unknown[] = [];
let updateReturn: unknown[] = [];
let selectReturn: unknown[] = [];
let insertShouldThrow = false;
// Captured audit inserts: only rows written to auditLogsTable land here.
let auditInserts: Array<Record<string, unknown>> = [];

function thenable<T>(result: T, extra: Record<string, unknown> = {}) {
  const p = Promise.resolve(result);
  return {
    ...extra,
    then: (r: (v: T) => unknown, j?: (e: unknown) => unknown) => p.then(r, j),
    catch: (j: (e: unknown) => unknown) => p.catch(j),
    finally: (f: () => void) => p.finally(f),
  };
}

function selectChain() {
  const p = Promise.resolve(selectReturn);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    offset: () => chain,
    orderBy: () => chain,
    innerJoin: () => chain,
    $dynamic: () => chain,
    then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => p.then(r, j),
    catch: (j: (e: unknown) => unknown) => p.catch(j),
    finally: (f: () => void) => p.finally(f),
  };
  return chain;
}

const db = {
  insert: (table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      if (table === auditLogsTable) {
        if (insertShouldThrow) {
          return thenable(Promise.reject(new Error("audit insert failed")), {
            onConflictDoUpdate: () => thenable(undefined),
            returning: () => Promise.resolve([]),
          });
        }
        auditInserts.push(vals);
      }
      return thenable(undefined, {
        onConflictDoUpdate: () => thenable(undefined),
        returning: () => Promise.resolve([]),
      });
    },
  }),
  delete: () => ({
    where: () => ({ returning: () => Promise.resolve(deleteReturn) }),
  }),
  update: () => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(updateReturn) }) }),
  }),
  select: () => selectChain(),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
};

vi.mock("@workspace/db", () => ({
  db,
  auditLogsTable,
  assetsTable,
  brandsTable,
  appSettingsTable,
  socialAccountsTable,
  costLogsTable,
  creativesTable,
  creativeVariantsTable,
  calendarEntriesTable,
  socialContentPlanItemsTable,
  hashtagSetsTable,
  templatesTable,
}));

// drizzle-orm operators are opaque markers here — the db mock ignores predicates.
const op = () => ({});
vi.mock("drizzle-orm", () => ({
  eq: op, ne: op, and: op, or: op, inArray: op, ilike: op, desc: op,
  gte: op, lte: op, lt: op, isNotNull: op, arrayContains: op,
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

// Storage is irrelevant to audit behavior; stub it so object-storage never loads.
vi.mock("../services/storage.js", () => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  resolveUrl: () => null,
  writeFromFile: vi.fn().mockResolvedValue(undefined),
  writeBuffer: vi.fn().mockResolvedValue(undefined),
}));

// Publish scheduler is a no-op in tests (calendar-entries imports it).
vi.mock("../services/publish-scheduler", () => ({
  publishEntry: vi.fn().mockResolvedValue(undefined),
  startPublishScheduler: vi.fn(),
  stopPublishScheduler: vi.fn(),
}));

const { recordAudit, actorFromRequest } = await import("./audit.js");

// -----------------------------------------------------------------------------
// Helper-level unit tests
// -----------------------------------------------------------------------------
describe("recordAudit helper", () => {
  beforeEach(() => {
    auditInserts = [];
    insertShouldThrow = false;
  });

  it("writes a row with actor, action, entity, ids and derived count", async () => {
    const ok = await recordAudit({
      actor: { id: "u1", role: "admin" },
      action: "asset.delete",
      entityType: "asset",
      entityIds: ["a1", "a2"],
      brandId: "b1",
      metadata: { foo: "bar" },
    });
    expect(ok).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actorId: "u1",
      actorRole: "admin",
      action: "asset.delete",
      entityType: "asset",
      entityIds: ["a1", "a2"],
      affectedCount: 2,
      brandId: "b1",
      metadata: { foo: "bar" },
    });
  });

  it("honors an explicit affectedCount over entityIds length", async () => {
    await recordAudit({
      actor: { id: "u1", role: "admin" },
      action: "asset.bulk_delete",
      entityType: "asset",
      entityIds: ["a1"],
      affectedCount: 5,
    });
    expect(auditInserts[0].affectedCount).toBe(5);
  });

  it("never throws and returns false when the audit write fails", async () => {
    insertShouldThrow = true;
    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await recordAudit({
          actor: { id: "u1", role: "admin" },
          action: "asset.delete",
          entityType: "asset",
          entityIds: ["a1"],
        });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBe(false);
  });

  it("actorFromRequest extracts id + role, falling back to unknown", () => {
    expect(actorFromRequest({ user: { id: "u9", role: "editor" } } as unknown as Request)).toEqual({
      id: "u9",
      role: "editor",
    });
    expect(actorFromRequest({} as Request)).toEqual({ id: "unknown", role: "unknown" });
    expect(actorFromRequest({ user: { id: "u9" } } as unknown as Request)).toEqual({
      id: "u9",
      role: "unknown",
    });
  });
});

// -----------------------------------------------------------------------------
// Route-level integration tests: the real handlers must write audit records.
// -----------------------------------------------------------------------------
const assetsRouter = (await import("../routes/assets.js")).default;
const brandsRouter = (await import("../routes/brands.js")).default;
const settingsRouter = (await import("../routes/settings.js")).default;
const socialAccountsRouter = (await import("../routes/social-accounts.js")).default;
const calendarEntriesRouter = (await import("../routes/calendar-entries.js")).default;
const contentPlanRouter = (await import("../routes/content-plan.js")).default;
const hashtagSetsRouter = (await import("../routes/hashtag-sets.js")).default;

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
}

/** Get the terminal handler for `method path` (after guards/validators). */
function getHandler(
  router: { stack: RouteLayer[] },
  method: string,
  path: string,
): (req: Request, res: Response) => Promise<void> {
  const layer = router.stack.find(
    (l) => l.route?.path === path && l.route?.methods?.[method] === true,
  );
  if (!layer?.route) throw new Error(`route not found: ${method} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: Request, res: Response) => Promise<void>;
}

function mockReq(over: Partial<Request> & Record<string, unknown>): Request {
  return {
    body: {},
    params: {},
    query: {},
    user: { id: "admin-1", role: "admin" },
    method: "DELETE",
    ...over,
  } as unknown as Request;
}

interface CapturingRes {
  statusCode: number;
  body: unknown;
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
      res.body = b;
      return res;
    },
  };
  return res;
}

describe("destructive & privileged routes write audit records", () => {
  beforeEach(() => {
    auditInserts = [];
    insertShouldThrow = false;
    deleteReturn = [];
    updateReturn = [];
    selectReturn = [];
  });

  it("asset bulk-delete records action + affected ids/count", async () => {
    deleteReturn = [
      { id: "a1", fileUrl: null, thumbnailUrl: null, brandId: "b1", name: "one" },
      { id: "a2", fileUrl: null, thumbnailUrl: null, brandId: "b1", name: "two" },
    ];
    const handler = getHandler(assetsRouter as never, "post", "/assets/bulk-delete");
    const res = mockRes();
    await handler(mockReq({ body: { ids: ["a1", "a2", "missing"] }, method: "POST" }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      actorId: "admin-1",
      actorRole: "admin",
      action: "asset.bulk_delete",
      entityType: "asset",
      entityIds: ["a1", "a2"],
      affectedCount: 2,
    });
  });

  it("asset single delete records action + entity id", async () => {
    deleteReturn = [{ id: "a1", fileUrl: null, thumbnailUrl: null, brandId: "b1", name: "one" }];
    const handler = getHandler(assetsRouter as never, "delete", "/assets/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "a1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "asset.delete",
      entityType: "asset",
      entityIds: ["a1"],
      brandId: "b1",
    });
  });

  it("does NOT record an audit when the asset delete affects nothing (404)", async () => {
    deleteReturn = [];
    const handler = getHandler(assetsRouter as never, "delete", "/assets/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "nope" } }), res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect(auditInserts).toHaveLength(0);
  });

  it("brand archive records action + entity id", async () => {
    updateReturn = [{ id: "b1", name: "Acme" }];
    const handler = getHandler(brandsRouter as never, "delete", "/brands/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "b1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "brand.archive",
      entityType: "brand",
      entityIds: ["b1"],
      brandId: "b1",
    });
  });

  it("settings update records the changed keys", async () => {
    selectReturn = [{ key: "dailyCostThreshold", value: "100" }];
    const handler = getHandler(settingsRouter as never, "put", "/settings");
    const res = mockRes();
    await handler(mockReq({ body: { dailyCostThreshold: "100" }, method: "PUT" }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "settings.update",
      entityType: "setting",
      entityIds: ["dailyCostThreshold"],
      affectedCount: 1,
    });
  });

  it("social account delete records action + entity id", async () => {
    deleteReturn = [{ id: "s1", brandId: "b1", platform: "twitter", accountName: "@acme" }];
    const handler = getHandler(socialAccountsRouter as never, "delete", "/social-accounts/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "s1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "social_account.delete",
      entityType: "social_account",
      entityIds: ["s1"],
      brandId: "b1",
    });
  });

  it("calendar entry delete records action + entity id", async () => {
    deleteReturn = [{ id: "c1", platform: "twitter", creativeId: "cr1" }];
    const handler = getHandler(calendarEntriesRouter as never, "delete", "/calendar-entries/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "c1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "calendar_entry.delete",
      entityType: "calendar_entry",
      entityIds: ["c1"],
    });
  });

  it("content plan delete records action + entity id", async () => {
    deleteReturn = [{ id: "p1", brandId: "b1" }];
    const handler = getHandler(contentPlanRouter as never, "delete", "/content-plan/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "p1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "content_plan.delete",
      entityType: "content_plan_item",
      entityIds: ["p1"],
    });
  });

  it("hashtag set delete records action + entity id", async () => {
    deleteReturn = [{ id: "h1", brandId: "b1" }];
    const handler = getHandler(hashtagSetsRouter as never, "delete", "/hashtag-sets/:id");
    const res = mockRes();
    await handler(mockReq({ params: { id: "h1" } }), res as unknown as Response);

    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      action: "hashtag_set.delete",
      entityType: "hashtag_set",
      entityIds: ["h1"],
      brandId: "b1",
    });
  });
});

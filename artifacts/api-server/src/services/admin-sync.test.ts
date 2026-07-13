import { describe, it, expect, vi, beforeEach } from "vitest";

// --- DB mock -------------------------------------------------------------
// Same chainable/thenable pattern as routes/users.test.ts: every builder
// method returns the same object; awaiting resolves to the next queued
// result for that verb.
let selectResults: unknown[][] = [];
let updateResults: (unknown[] | Error)[] = [];
let insertResults: (unknown[] | Error)[] = [];
let selectCall = 0;
let updateCall = 0;
let insertCall = 0;
let updateInvocations = 0;
let insertInvocations = 0;
let selectErrors: (Error | undefined)[] = [];

function thenable(getResult: () => unknown[] | Error) {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "where", "limit", "orderBy", "returning", "set", "values"];
  for (const m of methods) obj[m] = () => obj;
  (obj as { then: unknown }).then = (
    resolve: (v: unknown[]) => unknown,
    reject: (e: unknown) => unknown,
  ) => {
    const result = getResult();
    if (result instanceof Error) return Promise.reject(result).then(resolve, reject);
    return Promise.resolve(result).then(resolve, reject);
  };
  return obj;
}

vi.mock("@workspace/db", () => ({
  usersTable: { id: "id", email: "email", name: "name", role: "role" },
  auditLogsTable: {},
  db: {
    select: () =>
      thenable(() => {
        const err = selectErrors[selectCall];
        const rows = selectResults[selectCall] ?? [];
        selectCall++;
        return err ?? rows;
      }),
    update: () => {
      updateInvocations++;
      return thenable(() => updateResults[updateCall++] ?? []);
    },
    insert: () => {
      insertInvocations++;
      return thenable(() => insertResults[insertCall++] ?? []);
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ({ op: "eq", a }),
  ne: (...a: unknown[]) => ({ op: "ne", a }),
  and: (...a: unknown[]) => ({ op: "and", a }),
  count: () => ({ op: "count" }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

const auditCalls: Array<Record<string, unknown>> = [];
vi.mock("../lib/audit", () => ({
  recordAudit: vi.fn(async (params: Record<string, unknown>) => {
    auditCalls.push(params);
    return true;
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { syncAdminEmails } = await import("./admin-sync.js");

beforeEach(() => {
  selectResults = [];
  updateResults = [];
  insertResults = [];
  selectErrors = [];
  selectCall = 0;
  updateCall = 0;
  insertCall = 0;
  updateInvocations = 0;
  insertInvocations = 0;
  auditCalls.length = 0;
  delete process.env.ADMIN_EMAILS;
});

describe("syncAdminEmails", () => {
  it("promotes an existing viewer to admin and audits it", async () => {
    process.env.ADMIN_EMAILS = "da@sparqgames.com";
    selectResults = [[{ id: "u1", email: "da@sparqgames.com", role: "viewer" }]];
    updateResults = [[{ id: "u1" }]];

    await syncAdminEmails();

    expect(updateInvocations).toBe(1);
    expect(insertInvocations).toBe(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      action: "user.admin_sync_promote",
      entityType: "user",
      entityIds: ["u1"],
      actor: { id: "system", role: "system" },
    });
    expect((auditCalls[0].metadata as Record<string, unknown>).previousRole).toBe("viewer");
  });

  it("creates a pending admin invite for an email with no user row", async () => {
    process.env.ADMIN_EMAILS = "chase@sparqgames.com";
    // 1st select: admin-sync lookup (miss); 2nd select: inviteUser pre-check (miss)
    selectResults = [[], []];
    insertResults = [[{ id: "u2", email: "chase@sparqgames.com", name: null, role: "admin", updatedAt: new Date() }]];

    await syncAdminEmails();

    expect(insertInvocations).toBe(1);
    expect(updateInvocations).toBe(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      action: "user.admin_sync_invite",
      entityType: "user",
      entityIds: ["u2"],
      actor: { id: "system", role: "system" },
    });
  });

  it("is a no-op for a user who is already admin", async () => {
    process.env.ADMIN_EMAILS = "tony@sparqgames.com";
    selectResults = [[{ id: "u3", email: "tony@sparqgames.com", role: "admin" }]];

    await syncAdminEmails();

    expect(updateInvocations).toBe(0);
    expect(insertInvocations).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("never issues a demoting update — only sets admin on non-admin rows", async () => {
    process.env.ADMIN_EMAILS = "editor@sparqgames.com,admin@sparqgames.com";
    selectResults = [
      [{ id: "e1", email: "editor@sparqgames.com", role: "editor" }],
      [{ id: "a1", email: "admin@sparqgames.com", role: "admin" }],
    ];
    updateResults = [[{ id: "e1" }]];

    await syncAdminEmails();

    // exactly one update (the editor promotion); the admin row is untouched
    expect(updateInvocations).toBe(1);
    expect(auditCalls).toHaveLength(1);
    expect((auditCalls[0].metadata as Record<string, unknown>).newRole).toBe("admin");
  });

  it("does nothing when ADMIN_EMAILS is unset", async () => {
    await syncAdminEmails();
    expect(updateInvocations).toBe(0);
    expect(insertInvocations).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("does nothing when ADMIN_EMAILS is empty or only separators", async () => {
    process.env.ADMIN_EMAILS = " , ,, ";
    await syncAdminEmails();
    expect(updateInvocations).toBe(0);
    expect(insertInvocations).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("skips malformed entries without crashing and still processes valid ones", async () => {
    process.env.ADMIN_EMAILS = "not-an-email,jan@sparqgames.com";
    // "not-an-email": admin-sync lookup (miss), inviteUser rejects it as
    // invalid_email before touching the db again.
    // "jan@...": lookup (miss) + inviteUser pre-check (miss), then insert.
    selectResults = [[], [], []];
    insertResults = [[{ id: "u4", email: "jan@sparqgames.com", name: null, role: "admin", updatedAt: new Date() }]];

    await expect(syncAdminEmails()).resolves.toBeUndefined();

    expect(insertInvocations).toBe(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ action: "user.admin_sync_invite", entityIds: ["u4"] });
  });

  it("promotes an existing row stored with mixed-case email instead of inviting a duplicate", async () => {
    process.env.ADMIN_EMAILS = "da@sparqgames.com";
    // The lookup is lower(email) = 'da@...', so a mixed-case DB row matches.
    selectResults = [[{ id: "u1", email: "Da@SparqGames.com", role: "viewer" }]];
    updateResults = [[{ id: "u1" }]];

    await syncAdminEmails();

    expect(updateInvocations).toBe(1);
    expect(insertInvocations).toBe(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ action: "user.admin_sync_promote", entityIds: ["u1"] });
  });

  it("matches case-insensitively and dedupes the list", async () => {
    process.env.ADMIN_EMAILS = "DA@SparqGames.com, da@sparqgames.com";
    selectResults = [[{ id: "u1", email: "da@sparqgames.com", role: "viewer" }]];
    updateResults = [[{ id: "u1" }]];

    await syncAdminEmails();

    // deduped to a single email → single lookup, single update
    expect(selectCall).toBe(1);
    expect(updateInvocations).toBe(1);
  });

  it("tolerates a db error on one email and continues with the rest", async () => {
    process.env.ADMIN_EMAILS = "broken@sparqgames.com,ok@sparqgames.com";
    selectErrors = [new Error("connection refused"), undefined];
    selectResults = [[], [{ id: "u5", email: "ok@sparqgames.com", role: "viewer" }]];
    updateResults = [[{ id: "u5" }]];

    await expect(syncAdminEmails()).resolves.toBeUndefined();

    expect(updateInvocations).toBe(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ action: "user.admin_sync_promote", entityIds: ["u5"] });
  });
});

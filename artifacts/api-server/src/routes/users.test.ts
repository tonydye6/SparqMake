import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// --- DB mock -------------------------------------------------------------
// Every query builder method returns the same chainable, thenable object so
// awaiting at any point in the chain resolves to a queued result. Each
// db.select()/db.update() call consumes the next queued result in order.
let selectResults: unknown[][] = [];
let updateResults: unknown[][] = [];
// An entry may be a rows array (resolves) or an Error (rejects), so we can
// simulate a Postgres unique-violation on insert or FK-violation on delete.
let insertResults: (unknown[] | Error)[] = [];
let deleteResults: (unknown[] | Error)[] = [];
let selectCall = 0;
let updateCall = 0;
let insertCall = 0;
let deleteCall = 0;

function thenable(getResult: () => unknown[] | Error) {
  const obj: Record<string, unknown> = {};
  const methods = [
    "from", "where", "limit", "orderBy", "returning", "set", "values",
    "onConflictDoUpdate", "groupBy",
  ];
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
  db: {
    select: () => thenable(() => selectResults[selectCall++] ?? []),
    update: () => thenable(() => updateResults[updateCall++] ?? []),
    insert: () => thenable(() => insertResults[insertCall++] ?? []),
    delete: () => thenable(() => deleteResults[deleteCall++] ?? []),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ({ op: "eq", a }),
  ne: (...a: unknown[]) => ({ op: "ne", a }),
  and: (...a: unknown[]) => ({ op: "and", a }),
  count: () => ({ op: "count" }),
}));

const { listUsers, updateUserRole, inviteUser, deleteUser, isValidRole, UserManagementError } =
  await import("../services/user-management.js");
const { requireRole } = await import("../middleware/auth.js");

beforeEach(() => {
  selectResults = [];
  updateResults = [];
  insertResults = [];
  deleteResults = [];
  selectCall = 0;
  updateCall = 0;
  insertCall = 0;
  deleteCall = 0;
});

// --- admin-only access ---------------------------------------------------

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (code: number) => unknown; json: (payload: unknown) => unknown } = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function runGuard(role: string) {
  const req = { user: { role }, method: "GET" } as unknown as Request;
  const res = mockRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  requireRole("admin")(req, res, next);
  return { res, nextCalled };
}

describe("user-management admin-only access", () => {
  it("rejects viewers with 403", () => {
    const { res, nextCalled } = runGuard("viewer");
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("rejects editors with 403", () => {
    const { res, nextCalled } = runGuard("editor");
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("allows admins through", () => {
    const { nextCalled } = runGuard("admin");
    expect(nextCalled).toBe(true);
  });
});

// --- role validation -----------------------------------------------------

describe("role validation", () => {
  it("accepts the allowed roles", () => {
    expect(isValidRole("viewer")).toBe(true);
    expect(isValidRole("editor")).toBe(true);
    expect(isValidRole("admin")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidRole("superadmin")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole(undefined)).toBe(false);
  });

  it("updateUserRole throws invalid_role for a bad role", async () => {
    const rejection = await updateUserRole("u1", "superadmin").catch((e) => e);
    expect(rejection).toBeInstanceOf(UserManagementError);
    expect(rejection).toMatchObject({ code: "invalid_role" });
  });
});

// --- update behavior + last-admin protection -----------------------------

describe("updateUserRole", () => {
  it("throws not_found when the user does not exist", async () => {
    selectResults = [[]]; // target lookup: none
    await expect(updateUserRole("missing", "editor")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("promotes a viewer to editor without touching the admin-count guard", async () => {
    selectResults = [[{ id: "u1", email: "a@b.c", name: null, role: "viewer" }]];
    updateResults = [[{ id: "u1", email: "a@b.c", name: null, role: "editor" }]];
    const result = await updateUserRole("u1", "editor");
    expect(result.role).toBe("editor");
    // Only the target lookup select ran; no admin-count query.
    expect(selectCall).toBe(1);
  });

  it("blocks demoting the last remaining admin", async () => {
    selectResults = [
      [{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }], // target
      [{ value: 0 }], // no other admins
    ];
    await expect(updateUserRole("admin1", "viewer")).rejects.toMatchObject({
      code: "last_admin",
    });
    // Never reached the update.
    expect(updateCall).toBe(0);
  });

  it("allows demoting an admin when another admin remains", async () => {
    selectResults = [
      [{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }], // target
      [{ value: 1 }], // one other admin remains
    ];
    updateResults = [[{ id: "admin1", email: "t@b.c", name: "Tony", role: "viewer" }]];
    const result = await updateUserRole("admin1", "viewer");
    expect(result.role).toBe("viewer");
  });

  it("allows keeping an admin as admin (no self-lockout false positive)", async () => {
    selectResults = [
      [{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }], // target
    ];
    updateResults = [[{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }]];
    const result = await updateUserRole("admin1", "admin");
    expect(result.role).toBe("admin");
    // role unchanged → no admin-count guard query.
    expect(selectCall).toBe(1);
  });
});

describe("inviteUser", () => {
  it("rejects an invalid role", async () => {
    await expect(inviteUser("new@b.c", "superadmin")).rejects.toMatchObject({
      code: "invalid_role",
    });
  });

  it("rejects a malformed email", async () => {
    await expect(inviteUser("not-an-email", "viewer")).rejects.toMatchObject({
      code: "invalid_email",
    });
  });

  it("rejects a duplicate email (pre-check)", async () => {
    selectResults = [[{ id: "u1", email: "dupe@b.c", name: null, role: "viewer" }]];
    await expect(inviteUser("dupe@b.c", "editor")).rejects.toMatchObject({
      code: "duplicate_email",
    });
    // Never reached the insert.
    expect(insertCall).toBe(0);
  });

  it("creates a user with the assigned role, normalizing the email", async () => {
    selectResults = [[]]; // duplicate pre-check: none
    insertResults = [[{ id: "u9", email: "new@b.c", name: null, role: "editor" }]];
    const created = await inviteUser("  New@B.C  ", "editor");
    expect(created).toMatchObject({ id: "u9", email: "new@b.c", role: "editor" });
    expect(insertCall).toBe(1);
  });

  it("maps a unique-violation race on insert to duplicate_email", async () => {
    selectResults = [[]]; // pre-check passes
    insertResults = [Object.assign(new Error("duplicate key"), { code: "23505" })];
    await expect(inviteUser("racer@b.c", "viewer")).rejects.toMatchObject({
      code: "duplicate_email",
    });
  });
});

// --- deletion + last-admin protection ------------------------------------

describe("deleteUser", () => {
  it("throws not_found when the user does not exist", async () => {
    selectResults = [[]]; // target lookup: none
    await expect(deleteUser("missing")).rejects.toMatchObject({ code: "not_found" });
    expect(deleteCall).toBe(0);
  });

  it("deletes a non-admin without touching the admin-count guard", async () => {
    selectResults = [[{ id: "u1", email: "a@b.c", name: "A", role: "viewer" }]];
    deleteResults = [[{ id: "u1", email: "a@b.c", name: "A", role: "viewer" }]];
    const removed = await deleteUser("u1");
    expect(removed.id).toBe("u1");
    // Only the target lookup select ran; no admin-count query.
    expect(selectCall).toBe(1);
    expect(deleteCall).toBe(1);
  });

  it("revokes a pending invite (name null, never signed in)", async () => {
    selectResults = [[{ id: "u2", email: "pending@b.c", name: null, role: "editor" }]];
    deleteResults = [[{ id: "u2", email: "pending@b.c", name: null, role: "editor" }]];
    const removed = await deleteUser("u2");
    expect(removed.email).toBe("pending@b.c");
  });

  it("blocks deleting the last remaining admin", async () => {
    selectResults = [
      [{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }], // target
      [{ value: 0 }], // no other admins
    ];
    await expect(deleteUser("admin1")).rejects.toMatchObject({ code: "last_admin" });
    // Never reached the delete.
    expect(deleteCall).toBe(0);
  });

  it("allows deleting an admin when another admin remains", async () => {
    selectResults = [
      [{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }], // target
      [{ value: 1 }], // one other admin remains
    ];
    deleteResults = [[{ id: "admin1", email: "t@b.c", name: "Tony", role: "admin" }]];
    const removed = await deleteUser("admin1");
    expect(removed.id).toBe("admin1");
  });

  it("maps a FK-restrict violation to has_content", async () => {
    selectResults = [[{ id: "u3", email: "c@b.c", name: "C", role: "editor" }]];
    deleteResults = [Object.assign(new Error("violates foreign key constraint"), { code: "23503" })];
    await expect(deleteUser("u3")).rejects.toMatchObject({ code: "has_content" });
  });

  it("maps a drizzle-wrapped FK violation (code on cause) to has_content", async () => {
    selectResults = [[{ id: "u4", email: "d@b.c", name: "D", role: "editor" }]];
    const wrapped = new Error("Failed query: delete from users ...");
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error("fk"), { code: "23503" });
    deleteResults = [wrapped];
    await expect(deleteUser("u4")).rejects.toMatchObject({ code: "has_content" });
  });
});

describe("listUsers", () => {
  it("returns all users", async () => {
    selectResults = [
      [
        { id: "u1", email: "a@b.c", name: "A", role: "admin" },
        { id: "u2", email: "b@b.c", name: "B", role: "viewer" },
      ],
    ];
    const users = await listUsers();
    expect(users).toHaveLength(2);
    expect(users[0].role).toBe("admin");
  });
});

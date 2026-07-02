import { describe, it, expect, vi, beforeEach } from "vitest";

// --- In-memory users table -------------------------------------------------
// The db mock evaluates the real WHERE predicate built by cleanupDevBypassUser
// against these rows, so the tests exercise the actual deletion scope (not
// just "delete was called"). A regression that widens the WHERE clause will
// delete an ordinary user row here and fail the test.
type UserRow = { id: string; email: string; name: string; role: string };
let usersRows: UserRow[] = [];
let deleteCalls = 0;

// Column sentinels: predicates read row values via the column's `key`.
const usersTable = {
  id: { key: "id" },
  email: { key: "email" },
  name: { key: "name" },
  role: { key: "role" },
};

type Predicate = (row: Record<string, unknown>) => boolean;
type Col = { key: string };

vi.mock("drizzle-orm", () => ({
  eq: (col: Col, value: unknown): Predicate => (row) => row[col.key] === value,
  or: (...preds: Predicate[]): Predicate => (row) => preds.some((p) => p(row)),
  inArray: (col: Col, values: unknown[]): Predicate => (row) =>
    values.includes(row[col.key]),
}));

vi.mock("@workspace/db", () => ({
  usersTable,
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    delete: (table: unknown) => {
      deleteCalls++;
      if (table !== usersTable) throw new Error("unexpected table in delete");
      return {
        where: (pred: Predicate) => ({
          returning: () => {
            const removed = usersRows.filter((r) => pred(r));
            usersRows = usersRows.filter((r) => !pred(r));
            return Promise.resolve(removed);
          },
        }),
      };
    },
  },
}));

// Import after mocks are registered. isDevBypass() reads env at call time, so
// each test can flip DEV_AUTH_BYPASS without re-importing.
const { cleanupDevBypassUser } = await import("./auth.js");

const DEV_ID = "dev-user-00000000-0000-0000-0000-000000000000";

const adminUser: UserRow = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "admin@example.com",
  name: "Real Admin",
  role: "admin",
};
const viewerUser: UserRow = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "viewer@example.com",
  name: "Real Viewer",
  role: "viewer",
};

beforeEach(() => {
  usersRows = [];
  deleteCalls = 0;
  delete process.env.DEV_AUTH_BYPASS;
  delete process.env.REPLIT_DEPLOYMENT;
});

describe("cleanupDevBypassUser", () => {
  it("deletes the row matching the reserved dev-bypass id, even if its email drifted", async () => {
    usersRows = [
      adminUser,
      // Email drifted to something unrecognized — id must still match.
      { id: DEV_ID, email: "drifted@whatever.local", name: "Dev User", role: "editor" },
      viewerUser,
    ];

    await cleanupDevBypassUser();

    expect(usersRows.map((r) => r.id).sort()).toEqual(
      [adminUser.id, viewerUser.id].sort(),
    );
  });

  it("deletes a row matching a historical dev-bypass email (legacy sparqforge domain) with a different id", async () => {
    usersRows = [
      adminUser,
      // Legacy record created by an old build under a different id.
      { id: "33333333-3333-3333-3333-333333333333", email: "dev@sparqforge.local", name: "Dev User", role: "editor" },
      viewerUser,
    ];

    await cleanupDevBypassUser();

    expect(usersRows).toHaveLength(2);
    expect(usersRows.some((r) => r.email === "dev@sparqforge.local")).toBe(false);
  });

  it("deletes the current dev-bypass email too", async () => {
    usersRows = [
      { id: "44444444-4444-4444-4444-444444444444", email: "dev@sparqmake.local", name: "Dev User", role: "editor" },
      adminUser,
    ];

    await cleanupDevBypassUser();

    expect(usersRows).toEqual([adminUser]);
  });

  it("leaves ordinary users untouched when no dev-bypass row exists", async () => {
    usersRows = [adminUser, viewerUser];

    await cleanupDevBypassUser();

    expect(deleteCalls).toBe(1);
    expect(usersRows).toEqual([adminUser, viewerUser]);
  });

  it("never deletes a real user whose id/email merely resemble the dev account", async () => {
    const lookalikes: UserRow[] = [
      // Similar but not identical id.
      { id: "dev-user-00000000-0000-0000-0000-000000000001", email: "a@example.com", name: "A", role: "editor" },
      // Real user on a different domain with a "dev" local part.
      { id: "55555555-5555-5555-5555-555555555555", email: "dev@sparqmake.com", name: "B", role: "admin" },
      // Uppercase variant is a distinct string; only the exact reserved
      // literals are ever inserted by the bypass, so only those may match.
      { id: "66666666-6666-6666-6666-666666666666", email: "DEV@sparqmake.local2", name: "C", role: "viewer" },
    ];
    usersRows = [...lookalikes];

    await cleanupDevBypassUser();

    expect(usersRows).toEqual(lookalikes);
  });

  it("is a no-op (issues no DELETE at all) when the dev bypass is active", async () => {
    process.env.DEV_AUTH_BYPASS = "true";
    usersRows = [
      { id: DEV_ID, email: "dev@sparqmake.local", name: "Dev User", role: "editor" },
      adminUser,
    ];

    await cleanupDevBypassUser();

    expect(deleteCalls).toBe(0);
    expect(usersRows).toHaveLength(2);
  });

  it("still deletes when DEV_AUTH_BYPASS=true leaks into a deployed environment (bypass is not honored)", async () => {
    process.env.DEV_AUTH_BYPASS = "true";
    process.env.REPLIT_DEPLOYMENT = "1";
    usersRows = [
      { id: DEV_ID, email: "dev@sparqmake.local", name: "Dev User", role: "editor" },
      adminUser,
      viewerUser,
    ];

    await cleanupDevBypassUser();

    expect(deleteCalls).toBe(1);
    expect(usersRows).toEqual([adminUser, viewerUser]);
  });
});

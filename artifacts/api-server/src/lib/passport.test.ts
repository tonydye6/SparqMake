import { describe, it, expect, vi, beforeEach } from "vitest";

// --- DB mock -------------------------------------------------------------
// Chainable, thenable query builder: each db.select()/update()/insert() call
// consumes the next queued result in order (same pattern as users.test.ts).
let selectResults: unknown[][] = [];
let updateResults: unknown[][] = [];
let insertResults: unknown[][] = [];
let selectCall = 0;
let updateCall = 0;
let insertCall = 0;

function thenable(getResult: () => unknown[]) {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "where", "limit", "orderBy", "returning", "set", "values"];
  for (const m of methods) obj[m] = () => obj;
  (obj as { then: unknown }).then = (
    resolve: (v: unknown[]) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(getResult()).then(resolve, reject);
  return obj;
}

vi.mock("@workspace/db", () => ({
  usersTable: { id: "id", email: "email", name: "name", image: "image", role: "role" },
  db: {
    select: () => thenable(() => selectResults[selectCall++] ?? []),
    update: () => thenable(() => updateResults[updateCall++] ?? []),
    insert: () => thenable(() => insertResults[insertCall++] ?? []),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ({ op: "eq", a }),
  sql: (...a: unknown[]) => ({ op: "sql", a }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { verifyGoogleProfile } = await import("./passport.js");

function callVerify(profile: Parameters<typeof verifyGoogleProfile>[0]) {
  return new Promise<{ err: unknown; user: unknown }>((resolve) => {
    void verifyGoogleProfile(profile, (err, user) => resolve({ err, user }));
  });
}

beforeEach(() => {
  selectResults = [];
  updateResults = [];
  insertResults = [];
  selectCall = 0;
  updateCall = 0;
  insertCall = 0;
  delete process.env.ALLOWED_EMAILS;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  delete process.env.ADMIN_EMAILS;
});

const invitedRow = {
  id: "u-1",
  email: "invitee@outside.example",
  name: null,
  image: null,
  role: "editor",
};

describe("verifyGoogleProfile — invite vs env allow-list gates", () => {
  it("lets an invited user sign in even when their email is NOT in the env allow-list", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "company.example";
    selectResults = [[invitedRow]];
    updateResults = [[{ ...invitedRow, name: "Invitee Person" }]];

    const { err, user } = await callVerify({
      displayName: "Invitee Person",
      emails: [{ value: "invitee@outside.example", verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toMatchObject({ id: "u-1", role: "editor", name: "Invitee Person" });
  });

  it("matches invited emails case-insensitively (invites are stored lowercased)", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "company.example";
    selectResults = [[invitedRow]];
    updateResults = [[{ ...invitedRow, name: "Invitee Person" }]];

    const { err, user } = await callVerify({
      displayName: "Invitee Person",
      emails: [{ value: "Invitee@Outside.example", verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toMatchObject({ id: "u-1", role: "editor" });
  });

  it("still blocks a stranger who was never invited and is not on the env allow-list", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "company.example";
    selectResults = [[]];

    const { err, user } = await callVerify({
      displayName: "Stranger",
      emails: [{ value: "stranger@outside.example", verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBe(false);
    expect(insertCall).toBe(0);
  });

  it("still admits a brand-new user whose domain is on the env allow-list", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "company.example";
    selectResults = [[]];
    insertResults = [[{ id: "u-2", email: "new@company.example", name: "New Person", image: null, role: "viewer" }]];

    const { err, user } = await callVerify({
      displayName: "New Person",
      emails: [{ value: "new@company.example", verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toMatchObject({ id: "u-2", role: "viewer" });
  });

  it("blocks everyone new when both env vars are unset, but invited users still get in", async () => {
    selectResults = [[], [invitedRow]];
    updateResults = [[{ ...invitedRow, name: "Invitee Person" }]];

    const blocked = await callVerify({
      emails: [{ value: "stranger@anywhere.example", verified: true }],
    });
    expect(blocked.user).toBe(false);

    const invited = await callVerify({
      displayName: "Invitee Person",
      emails: [{ value: "invitee@outside.example", verified: true }],
    });
    expect(invited.err).toBeNull();
    expect(invited.user).toMatchObject({ id: "u-1", role: "editor" });
  });

  it("rejects unverified Google emails before any gate", async () => {
    const { err, user } = await callVerify({
      emails: [{ value: "invitee@outside.example", verified: false }],
    });
    expect(err).toBeNull();
    expect(user).toBe(false);
    expect(selectCall).toBe(0);
  });

  it("preserves the pre-assigned role from the invite on first sign-in", async () => {
    process.env.ADMIN_EMAILS = "someoneelse@company.example";
    selectResults = [[{ ...invitedRow, role: "admin" }]];
    updateResults = [[{ ...invitedRow, role: "admin", name: "Invited Admin" }]];

    const { user } = await callVerify({
      displayName: "Invited Admin",
      emails: [{ value: "invitee@outside.example", verified: true }],
    });

    expect(user).toMatchObject({ role: "admin" });
  });
});

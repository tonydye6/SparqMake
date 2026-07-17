import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";

// --- DB mock (chainable thenable, queued results per call) ---------------
let selectResults: unknown[][] = [];
let insertResults: unknown[][] = [];
let updateResults: unknown[][] = [];
let deleteResults: unknown[][] = [];
let selectCall = 0, insertCall = 0, updateCall = 0, deleteCall = 0;

function thenable(getResult: () => unknown[]) {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "returning", "set", "values"]) obj[m] = () => obj;
  (obj as { then: unknown }).then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(getResult()).then(resolve, reject);
  return obj;
}

vi.mock("@workspace/db", () => ({
  designerPersonasTable: { id: "id", name: "name" },
  usersTable: { id: "id", email: "email" },
  db: {
    select: () => thenable(() => selectResults[selectCall++] ?? []),
    insert: () => thenable(() => insertResults[insertCall++] ?? []),
    update: () => thenable(() => updateResults[updateCall++] ?? []),
    delete: () => thenable(() => deleteResults[deleteCall++] ?? []),
  },
}));

// Audit logging is exercised elsewhere; here we just assert it is invoked for
// mutations without touching the DB.
const recordAudit = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../lib/audit.js", () => ({
  recordAudit: (...args: unknown[]) => recordAudit(...args),
  actorFromRequest: () => ({ id: "u1", email: "t@example.com" }),
}));

vi.mock("../services/screenshot.js", () => ({
  validateUrl: vi.fn(),
  captureScreenshots: vi.fn(),
}));
const analyzePersonaImages = vi.fn(async () => ({
  name: "Draft", description: "", typography: "t", composition: "c",
  colorPhilosophy: "cp", textureAndEffects: "te", mood: "m",
}));
vi.mock("../services/persona-analysis.js", () => ({
  analyzePersonaImages: (...args: unknown[]) => analyzePersonaImages(...(args as [])),
}));
vi.mock("../services/storage.js", () => ({
  writeBuffer: vi.fn(),
}));
vi.mock("@workspace/integrations-gemini-ai", () => ({ ai: {} }));

const routerModule = await import("./designer-personas.js");

// --- Test app: real router + real role guards, role injected per-request --
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) (req as { user?: unknown }).user = { id: "u1", role };
    next();
  });
  app.use("/api", routerModule.default);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  selectResults = []; insertResults = []; updateResults = []; deleteResults = [];
  selectCall = insertCall = updateCall = deleteCall = 0;
  recordAudit.mockClear();
});

const persona = {
  id: "p1", name: "Neo-Brutalist", description: "", sourceType: "manual", sourceUrl: null,
  typography: "t", composition: "c", colorPhilosophy: "cp", textureAndEffects: "te", mood: "m",
  referenceImages: [],
};

function call(method: string, path: string, opts: { role?: string; body?: unknown } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.role ? { "x-test-role": opts.role } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe("designer persona CRUD + authorization", () => {
  it("GET /designer-personas lists personas in a data envelope", async () => {
    selectResults = [[persona]];
    const res = await call("GET", "/api/designer-personas");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [persona] });
  });

  it("POST requires editor: viewer gets 403", async () => {
    const res = await call("POST", "/api/designer-personas", { role: "viewer", body: { name: "X" } });
    expect(res.status).toBe(403);
  });

  it("POST as editor creates the persona and records an audit entry", async () => {
    insertResults = [[persona]];
    const res = await call("POST", "/api/designer-personas", { role: "editor", body: { name: "Neo-Brutalist" } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe("p1");
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("POST validates the body (missing name → 400)", async () => {
    const res = await call("POST", "/api/designer-personas", { role: "editor", body: {} });
    expect(res.status).toBe(400);
  });

  it("PUT requires editor: viewer gets 403", async () => {
    const res = await call("PUT", "/api/designer-personas/p1", { role: "viewer", body: { name: "New" } });
    expect(res.status).toBe(403);
  });

  it("PUT as editor updates the persona", async () => {
    updateResults = [[{ ...persona, name: "Renamed" }]];
    const res = await call("PUT", "/api/designer-personas/p1", { role: "editor", body: { name: "Renamed" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Renamed");
  });

  it("PUT returns 404 when the persona does not exist", async () => {
    updateResults = [[]];
    const res = await call("PUT", "/api/designer-personas/missing", { role: "editor", body: { name: "X" } });
    expect(res.status).toBe(404);
  });

  it("DELETE is destructive: editor gets 403, admin succeeds with audit", async () => {
    const denied = await call("DELETE", "/api/designer-personas/p1", { role: "editor" });
    expect(denied.status).toBe(403);

    deleteResults = [[persona]];
    const res = await call("DELETE", "/api/designer-personas/p1", { role: "admin" });
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("unauthenticated mutation is rejected", async () => {
    const res = await call("POST", "/api/designer-personas", { body: { name: "X" } });
    expect(res.status).toBe(403);
  });
});

// --- Upload boundary at the 20-image cap --------------------------------

// Tiny valid 1x1 PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeForm(count: number): FormData {
  const form = new FormData();
  for (let i = 0; i < count; i++) {
    form.append("images", new Blob([PNG_BYTES], { type: "image/png" }), `sample-${i + 1}.png`);
  }
  return form;
}

function upload(path: string, form: FormData) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "x-test-role": "editor" },
    body: form,
  });
}

describe("upload limits: exactly 20 passes, 21 fails", () => {
  it("POST /analyze accepts exactly 20 images", async () => {
    const res = await upload("/api/designer-personas/analyze", makeForm(20));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { referenceImages: unknown[] } };
    expect(body.draft.referenceImages).toHaveLength(20);
  });

  it("POST /analyze rejects 21 images with a 400", async () => {
    const res = await upload("/api/designer-personas/analyze", makeForm(21));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("POST /:id/reference-images accepts exactly 20 images on an empty persona", async () => {
    selectResults = [[{ ...persona, referenceImages: [] }]];
    updateResults = [[{ ...persona, referenceImages: new Array(20).fill({ url: "/x" }) }]];
    const res = await upload("/api/designer-personas/p1/reference-images", makeForm(20));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { referenceImages: unknown[] };
    expect(body.referenceImages).toHaveLength(20);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("POST /:id/reference-images rejects 21 images in one request", async () => {
    const res = await upload("/api/designer-personas/p1/reference-images", makeForm(21));
    expect(res.status).toBe(400);
  });

  it("appending up to the 20-total cap works, going over is rejected with a clear message", async () => {
    // 15 existing + 5 new = exactly 20 → OK
    const fifteen = new Array(15).fill(0).map((_, i) => ({ url: `/existing-${i}` }));
    selectResults = [[{ ...persona, referenceImages: fifteen }]];
    updateResults = [[{ ...persona, referenceImages: new Array(20).fill({ url: "/x" }) }]];
    const ok = await upload("/api/designer-personas/p1/reference-images", makeForm(5));
    expect(ok.status).toBe(200);

    // 15 existing + 6 new = 21 → rejected with the cap message
    selectCall = 0;
    selectResults = [[{ ...persona, referenceImages: fifteen }]];
    const over = await upload("/api/designer-personas/p1/reference-images", makeForm(6));
    expect(over.status).toBe(400);
    const body = (await over.json()) as { error: string };
    expect(body.error).toMatch(/at most 20 reference images \(currently 15\)/);
  });
});

// --- Upload validation: per-file size limit and allowed types -------------

describe("upload validation: file size and type", () => {
  it("POST /analyze rejects a file over 10 MB with a clear 400", async () => {
    const form = new FormData();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    form.append("images", new Blob([big], { type: "image/png" }), "huge.png");
    const res = await upload("/api/designer-personas/analyze", form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/file too large/i);
  });

  it("POST /analyze rejects a disallowed type (PDF) with the allowed-types message", async () => {
    const form = new FormData();
    form.append("images", new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), "doc.pdf");
    const res = await upload("/api/designer-personas/analyze", form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Only PNG, JPEG, WebP, or GIF images are allowed");
  });

  it("POST /:id/reference-images rejects a file over 10 MB with a 400", async () => {
    const form = new FormData();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    form.append("images", new Blob([big], { type: "image/jpeg" }), "huge.jpg");
    const res = await upload("/api/designer-personas/p1/reference-images", form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/file too large/i);
  });

  it("POST /:id/reference-images rejects a disallowed type (PDF) with the allowed-types message", async () => {
    const form = new FormData();
    form.append("images", new Blob([Buffer.from("%PDF-1.4")], { type: "application/pdf" }), "doc.pdf");
    const res = await upload("/api/designer-personas/p1/reference-images", form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Only PNG, JPEG, WebP, or GIF images are allowed");
  });
});

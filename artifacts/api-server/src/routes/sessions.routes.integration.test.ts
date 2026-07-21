/**
 * Integration tests for the Co-pilot Studio turns endpoint — real test DB,
 * real Express router + middleware chain, mocked model boundaries.
 *
 * Covers:
 *  - D3: an unknown platform key is rejected 400 by the CreateTurnBody enum
 *  - D4: absent GEMINI_API_KEY returns 503 from POST /sessions/:id/turns
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.DEV_AUTH_BYPASS = "true";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-test";

// The session-service module tree pulls in every model/storage boundary; stub
// them so importing the router is cheap. Neither test path reaches executeTurn.
vi.mock("../services/session-service.js", () => ({
  createSession: vi.fn(),
  executeTurn: vi.fn(),
  getSessionWithTurns: vi.fn(),
  branchSession: vi.fn(),
}));

vi.mock("../services/taste-signals.js", () => ({
  recordTasteSignal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { db, pool, usersTable, brandsTable, creativesTable, studioSessionsTable, costLogsTable } =
  await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const sessionsRouter = (await import("./sessions.js")).default;

const RUN_ID = crypto.randomUUID().slice(0, 8);
let userId: string;
let brandId: string;
let creativeId: string;
let sessionId: string;
let server: Server;
let baseUrl: string;

const savedGeminiKey = process.env.GEMINI_API_KEY;

beforeAll(async () => {
  const [user] = await db.insert(usersTable).values({
    email: `copilot-routes-${RUN_ID}@test.local`,
    name: "Copilot Routes ITest",
    role: "editor",
  }).returning();
  userId = user.id;

  const [brand] = await db.insert(brandsTable).values({
    name: `Copilot Routes Brand ${RUN_ID}`,
    slug: `copilot-routes-${RUN_ID}`,
  }).returning();
  brandId = brand.id;

  const [creative] = await db.insert(creativesTable).values({
    brandId,
    name: "Routes ITest Creative",
    createdBy: userId,
  }).returning();
  creativeId = creative.id;

  const [session] = await db.insert(studioSessionsTable).values({
    creativeId,
    brandId,
    createdBy: userId,
  }).returning();
  sessionId = session.id;

  const app = express();
  app.use(express.json());
  // Dev-bypass style user injection so requireEditorForWrites sees an editor.
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: userId, role: "editor" };
    next();
  });
  app.use("/api", sessionsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedGeminiKey;

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(costLogsTable).where(eq(costLogsTable.creativeId, creativeId));
  await db.delete(brandsTable).where(eq(brandsTable.id, brandId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await pool.end();
});

async function postTurn(body: Record<string, unknown>, id = sessionId) {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // SSE responses are not JSON — tests below never expect them.
  }
  return { status: res.status, json };
}

describe("D3: platform enum validation on POST /sessions/:id/turns", () => {
  it("rejects an unknown platform key with 400", async () => {
    const { status, json } = await postTurn({
      action: "edit_image",
      instruction: "make it pop",
      platform: "myspace",
    });
    expect(status).toBe(400);
    expect(json?.error).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty-string platform with 400", async () => {
    const { status, json } = await postTurn({
      action: "edit_image",
      instruction: "make it pop",
      platform: "",
    });
    expect(status).toBe(400);
    expect(json?.error).toBe("VALIDATION_ERROR");
  });
});

describe("D4: missing GEMINI_API_KEY returns 503", () => {
  it("returns 503 for a valid turn request when the key is absent", async () => {
    delete process.env.GEMINI_API_KEY;

    const { status, json } = await postTurn({
      action: "draft",
      instruction: "a valid brief",
      platform: "instagram_feed",
    });
    expect(status).toBe(503);
    expect(json?.error).toBe("AI model access is not configured");
  });

  it("still 404s first when the session does not exist", async () => {
    delete process.env.GEMINI_API_KEY;

    const { status, json } = await postTurn(
      { action: "draft", instruction: "hi" },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(status).toBe(404);
    expect(json?.error).toBe("Session not found");
  });
});

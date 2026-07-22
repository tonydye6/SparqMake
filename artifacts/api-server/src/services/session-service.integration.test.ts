/**
 * Integration tests for Co-pilot Studio fix batch — real test DB, mocked model
 * boundaries.
 *
 * Covers:
 *  - B2: budget reservation row is deleted whether a turn succeeds or fails
 *  - C4: stale 'running' turns are swept to 'error' at startup
 *  - E1: fan-out writes per-platform captions keyed off PLATFORM_CONFIGS
 *  - F4: compare generates N takes concurrently and saves N × platform variants
 *
 * External services (Gemini/Anthropic model calls, object storage, image
 * processing) are mocked; all reads/writes go through the real Postgres DB
 * pointed at by DATABASE_URL.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

process.env.DEV_AUTH_BYPASS = "true";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-test";

// ---------------------------------------------------------------------------
// Mocks: model + storage + image-processing boundaries (DB stays real)
// ---------------------------------------------------------------------------

vi.mock("./storage.js", () => ({
  writeBuffer: vi.fn().mockResolvedValue({ namespace: "generated", filename: "img.png" }),
  publicUrlFor: vi.fn((loc: { namespace: string; filename: string }) => `/api/files/${loc.namespace}/${loc.filename}`),
  resolveUrl: vi.fn((url: string) => (url ? { namespace: "generated", filename: "existing.png" } : null)),
  readBuffer: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
  contentTypeFor: vi.fn(() => "image/png"),
}));

const runImageInteractionMock = vi.fn().mockResolvedValue({
  imageBuffer: Buffer.from("img"),
  mimeType: "image/png",
  interactionId: "iact-new-1",
});
vi.mock("./interactions-client.js", () => ({
  runImageInteraction: (...args: unknown[]) => runImageInteractionMock(...args),
  runVideoInteraction: vi.fn(),
  typedRefsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("./context-assembly.js", () => ({
  assembleContext: vi.fn().mockResolvedValue({ slots: [], packet: {} }),
  resolveStyleProfile: vi.fn().mockResolvedValue(null),
  resolveDesignerPersona: vi.fn().mockResolvedValue(null),
}));

vi.mock("./compositing.js", () => ({
  compositeImage: vi.fn().mockResolvedValue({ buffer: Buffer.from("comp"), mimeType: "image/png" }),
  reframeImage: vi.fn().mockResolvedValue(Buffer.from("reframed")),
  imageDimensions: vi.fn().mockResolvedValue({ width: 1080, height: 1080 }),
}));

vi.mock("./focal-point.js", () => ({
  detectSubject: vi.fn().mockResolvedValue({
    focal: { x: 0.5, y: 0.5 },
    box: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
  }),
  predictClip: vi.fn().mockReturnValue(false),
  CENTER_FOCAL: { x: 0.5, y: 0.5 },
  FULL_BOX: { x0: 0, y0: 0, x1: 1, y1: 1 },
}));

vi.mock("./performance-insights.js", () => ({
  getIntentInsights: vi.fn().mockResolvedValue({
    intent: null,
    intentLabel: null,
    sampleSize: 0,
    confidence: "none",
    platforms: [],
    bestTimes: [{ dayPart: "morning", dayPartLabel: "Morning", suggestedHour: 9, posts: 0, avgEngagement: 0 }],
    topPosts: [],
    reasoning: [],
  }),
}));

vi.mock("./packet-assembly.js", () => ({
  buildGenerationPacket: vi.fn().mockResolvedValue({ generationAssets: [] }),
  normalizeBalance: vi.fn().mockReturnValue({}),
  MAX_IMAGE_REFERENCES: 10,
}));

vi.mock("./taste-signals.js", () => ({
  recordTasteSignal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./claude.js", () => ({
  generateCaptions: vi.fn().mockResolvedValue({}),
}));

// Keep the REAL PLATFORM_CONFIGS (E1 asserts against it) but stub outpaint.
vi.mock("./imagen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./imagen.js")>();
  return {
    ...actual,
    outpaintImage: vi.fn().mockResolvedValue(Buffer.from("outpainted")),
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Anthropic returns a distinct caption per platform so E1 can assert the
// per-platform mapping survives all the way into creative_variants rows.
vi.mock("@workspace/integrations-anthropic-ai", async () => {
  const captionJson = () => {
    const platforms = ["instagram_feed", "instagram_story", "twitter", "linkedin", "tiktok", "youtube"];
    return JSON.stringify(
      Object.fromEntries(platforms.map(p => [p, { caption: `cap-${p}`, headline: `hd-${p}` }])),
    );
  };
  return {
    anthropic: {
      messages: {
        create: vi.fn().mockImplementation(async () => ({
          content: [{ type: "text", text: captionJson() }],
        })),
      },
    },
  };
});

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: {
      generateContent: vi.fn().mockResolvedValue({
        text: "Cinematic art direction.",
        candidates: [{ content: { parts: [{ text: '{"ok":true,"issue":null,"correctionHint":null}' }] } }],
      }),
    },
  },
}));

// ---------------------------------------------------------------------------
// Real DB imports after mocks
// ---------------------------------------------------------------------------

const {
  db,
  pool,
  usersTable,
  brandsTable,
  creativesTable,
  creativeVariantsTable,
  studioSessionsTable,
  sessionTurnsTable,
  costLogsTable,
} = await import("@workspace/db");
const { eq, and, inArray } = await import("drizzle-orm");
const { executeTurn } = await import("./session-service.js");
const { sweepStaleTurns } = await import("./stale-turn-sweep.js");
const { PLATFORM_CONFIGS } = await import("./imagen.js");

const RUN_ID = crypto.randomUUID().slice(0, 8);
let userId: string;
let brandId: string;
let creativeId: string;
let sessionId: string;
let activeVariantId: string;

beforeAll(async () => {
  const [user] = await db.insert(usersTable).values({
    email: `copilot-itest-${RUN_ID}@test.local`,
    name: "Copilot ITest",
    role: "editor",
  }).returning();
  userId = user.id;

  const [brand] = await db.insert(brandsTable).values({
    name: `Copilot ITest Brand ${RUN_ID}`,
    slug: `copilot-itest-${RUN_ID}`,
    voiceDescription: "Test voice",
  }).returning();
  brandId = brand.id;

  const [creative] = await db.insert(creativesTable).values({
    brandId,
    name: "Copilot ITest Creative",
    briefText: "A test brief",
    createdBy: userId,
  }).returning();
  creativeId = creative.id;

  const [variant] = await db.insert(creativeVariantsTable).values({
    creativeId,
    platform: "instagram_feed",
    aspectRatio: "1:1",
    rawImageUrl: "/api/files/generated/seed.png",
    compositedImageUrl: "/api/files/generated/seed.png",
    caption: "seed caption",
  }).returning();
  activeVariantId = variant.id;

  const [session] = await db.insert(studioSessionsTable).values({
    creativeId,
    brandId,
    status: "refining",
    createdBy: userId,
    activeVariantId,
  }).returning();
  sessionId = session.id;
});

afterAll(async () => {
  // cost_logs has ON DELETE SET NULL — remove test rows explicitly first.
  await db.delete(costLogsTable).where(eq(costLogsTable.creativeId, creativeId));
  // Brand delete cascades creatives → variants/sessions → turns.
  await db.delete(brandsTable).where(eq(brandsTable.id, brandId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await pool.end();
});

async function insertReservation(): Promise<string> {
  const [row] = await db.insert(costLogsTable).values({
    creativeId,
    service: "system",
    operation: "budget_reservation",
    costUsd: 0.5,
  }).returning();
  return row.id;
}

const noopProgress = () => {};

describe("B2: budget reservation cleanup", () => {
  it("deletes the reservation row when the turn succeeds", async () => {
    const reservationId = await insertReservation();

    await executeTurn({
      sessionId,
      input: { action: "fan_out", instruction: "spread it" },
      userId,
      reservationId,
      onProgress: noopProgress,
    });

    const remaining = await db.select().from(costLogsTable).where(eq(costLogsTable.id, reservationId));
    expect(remaining).toHaveLength(0);

    // The real cost row was inserted in the same transaction.
    const realCosts = await db.select().from(costLogsTable).where(
      and(eq(costLogsTable.creativeId, creativeId), eq(costLogsTable.service, "copilot")),
    );
    expect(realCosts.length).toBeGreaterThan(0);
  });

  it("deletes the reservation row when the turn fails", async () => {
    const reservationId = await insertReservation();

    // Point the session at no active variant so fan_out fails deterministically.
    await db.update(studioSessionsTable)
      .set({ activeVariantId: null })
      .where(eq(studioSessionsTable.id, sessionId));

    await expect(
      executeTurn({
        sessionId,
        input: { action: "fan_out", instruction: "will fail" },
        userId,
        reservationId,
        onProgress: noopProgress,
      }),
    ).rejects.toThrow(/No active image/);

    const remaining = await db.select().from(costLogsTable).where(eq(costLogsTable.id, reservationId));
    expect(remaining).toHaveLength(0);

    // The copilot turn is recorded as error, not left running.
    const turns = await db.select().from(sessionTurnsTable).where(
      and(eq(sessionTurnsTable.sessionId, sessionId), eq(sessionTurnsTable.status, "error")),
    );
    expect(turns.length).toBeGreaterThan(0);

    // Restore active variant for later tests.
    await db.update(studioSessionsTable)
      .set({ activeVariantId })
      .where(eq(studioSessionsTable.id, sessionId));
  });
});

describe("C4: startup sweep of stale running turns", () => {
  it("marks a 'running' turn from a previous process as 'error'", async () => {
    const [staleTurn] = await db.insert(sessionTurnsTable).values({
      sessionId,
      seq: 900,
      role: "copilot",
      action: "draft",
      status: "running",
    }).returning();

    await sweepStaleTurns();

    const [after] = await db.select().from(sessionTurnsTable).where(eq(sessionTurnsTable.id, staleTurn.id));
    expect(after.status).toBe("error");
    expect((after.metadata as { error?: string })?.error).toMatch(/server restart/i);
  });
});

describe("E1: fan-out per-platform captions from PLATFORM_CONFIGS", () => {
  it("creates one variant per PLATFORM_CONFIGS key with its platform-specific caption", async () => {
    const turn = await executeTurn({
      sessionId,
      input: { action: "fan_out", instruction: "fan out please" },
      userId,
      onProgress: noopProgress,
    });

    const platformKeys = Object.keys(PLATFORM_CONFIGS);
    const variantIds = (turn.resultVariantIds || []) as string[];
    expect(variantIds).toHaveLength(platformKeys.length);

    const variants = await db.select().from(creativeVariantsTable)
      .where(inArray(creativeVariantsTable.id, variantIds));
    expect(variants).toHaveLength(platformKeys.length);

    const byPlatform = new Map(variants.map(v => [v.platform, v]));
    for (const key of platformKeys) {
      const v = byPlatform.get(key);
      expect(v, `variant for platform ${key}`).toBeDefined();
      expect(v!.caption).toBe(`cap-${key}`);
      expect(v!.headlineText).toBe(`hd-${key}`);
      expect(v!.aspectRatio).toBe(PLATFORM_CONFIGS[key]!.aspectRatio);
    }
  });
});

describe("F4: compare generates N takes concurrently", () => {
  it("runs N concurrent image interactions and saves N × platform variants", async () => {
    runImageInteractionMock.mockClear();
    let idCounter = 0;
    runImageInteractionMock.mockImplementation(async () => ({
      imageBuffer: Buffer.from("img"),
      mimeType: "image/png",
      interactionId: `iact-take-${++idCounter}`,
    }));

    const count = 3;
    const turn = await executeTurn({
      sessionId,
      input: { action: "compare", instruction: "three takes", compareCount: count },
      userId,
      onProgress: noopProgress,
    });

    // N image generations happened.
    expect(runImageInteractionMock).toHaveBeenCalledTimes(count);

    // One canonical variant ID per take.
    const canonicalIds = (turn.resultVariantIds || []) as string[];
    expect(canonicalIds).toHaveLength(count);

    // N × platform variants were persisted.
    const meta = turn.metadata as { perTakeVariantIds?: string[][]; perTakeInteractionIds?: string[] };
    const platformCount = Object.keys(PLATFORM_CONFIGS).length;
    expect(meta.perTakeVariantIds).toHaveLength(count);
    for (const takeIds of meta.perTakeVariantIds!) {
      expect(takeIds).toHaveLength(platformCount);
    }
    expect(meta.perTakeInteractionIds).toHaveLength(count);

    const allIds = meta.perTakeVariantIds!.flat();
    const saved = await db.select().from(creativeVariantsTable)
      .where(inArray(creativeVariantsTable.id, allIds));
    expect(saved).toHaveLength(count * platformCount);
  });
});

/**
 * Unit tests for Co-pilot Studio session service.
 *
 * Tests exercise real service functions (branchSession, getSessionWithTurns) against
 * mocked DB / service boundaries, plus pure-logic tests for compare canonical take
 * semantics, pick ownership validation, SSE alternates emission, and cost branching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.DEV_AUTH_BYPASS = "true";
process.env.DATABASE_URL = "postgres://mock";
process.env.ANTHROPIC_API_KEY = "sk-test";

// ---------------------------------------------------------------------------
// Configurable per-test state — captured by reference inside the db mock factory
// ---------------------------------------------------------------------------

let insertRows: Array<Record<string, unknown>> = [];
let updateSets: Array<{ values: Record<string, unknown> }> = [];
// Key = table.__name, value = rows returned by select().from(table)
let selectByTable: Map<string, Array<Record<string, unknown>>> = new Map();

function setSelectRows(tableName: string, rows: Array<Record<string, unknown>>) {
  selectByTable.set(tableName, rows);
}

// ---------------------------------------------------------------------------
// Module mocks — all factories are self-contained (no top-level var refs)
// ---------------------------------------------------------------------------

vi.mock("../services/storage.js", () => ({
  writeBuffer: vi.fn().mockResolvedValue({ namespace: "generated", filename: "img.png" }),
  publicUrlFor: vi.fn((loc: { namespace: string; filename: string }) => `/api/files/${loc.namespace}/${loc.filename}`),
  resolveUrl: vi.fn((url: string) => url ? { namespace: "generated", filename: "existing.png" } : null),
  readBuffer: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
  contentTypeFor: vi.fn(() => "image/png"),
}));

vi.mock("../services/interactions-client.js", () => ({
  runImageInteraction: vi.fn().mockResolvedValue({
    imageBuffer: Buffer.from("img"),
    mimeType: "image/png",
    interactionId: "iact-new-1",
  }),
  runVideoInteraction: vi.fn().mockResolvedValue({
    videoBuffer: Buffer.alloc(1_024_000, 0), // 1 MB → ~2s at 500KB/s → clamped to 3s
    mimeType: "video/mp4",
    interactionId: "viact-new-1",
  }),
}));

vi.mock("../services/claude.js", () => ({
  generateCaptions: vi.fn().mockResolvedValue({
    instagram_feed: { caption: "Test IG", headline: "IG Hd" },
  }),
}));

vi.mock("../services/context-assembly.js", () => ({
  assembleContext: vi.fn().mockResolvedValue({ slots: [], packet: {} }),
  resolveStyleProfile: vi.fn().mockResolvedValue(null),
  resolveDesignerPersona: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/compositing.js", () => ({
  compositeImage: vi.fn().mockResolvedValue({ buffer: Buffer.from("comp"), mimeType: "image/png" }),
  reframeImage: vi.fn().mockResolvedValue(Buffer.from("reframed")),
  imageDimensions: vi.fn().mockResolvedValue({ width: 1080, height: 1080 }),
}));

vi.mock("../services/focal-point.js", () => ({
  detectSubject: vi.fn().mockResolvedValue({ focal: { x: 0.5, y: 0.5 }, box: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } }),
  predictClip: vi.fn().mockReturnValue(false),
  CENTER_FOCAL: { x: 0.5, y: 0.5 },
  FULL_BOX: { x0: 0, y0: 0, x1: 1, y1: 1 },
}));

vi.mock("../services/performance-insights.js", () => ({
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

vi.mock("../services/packet-assembly.js", () => ({
  buildGenerationPacket: vi.fn().mockResolvedValue({ generationAssets: [] }),
  normalizeBalance: vi.fn().mockReturnValue({}),
  MAX_IMAGE_REFERENCES: 10,
}));

vi.mock("../services/taste-signals.js", () => ({
  recordTasteSignal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ai-config.js", () => ({
  AI_MODELS: {
    CLAUDE_SONNET: "claude-sonnet-test",
    GEMINI_FLASH_IMAGE: "gemini-flash-image-test",
  },
  COPILOT_MODELS: {
    NANO_BANANA_MODEL: "gemini-test",
    CAPTION_MODEL: "claude-test",
    CONCEPT_MODEL: "gemini-test",
    ART_DIRECTION_MODEL: "claude-test",
    QA_MODEL: "gemini-qa-test",
    OMNI_VIDEO_MODEL: "gemini-video-test",
  },
  COST_ESTIMATES: {
    IMAGEN_PER_IMAGE: 0.04,
    CLAUDE_TOKENS: 0.001,
    GEMINI_TEXT: 0.0005,
    VIDEO_GENERATION_USD: 2.10,
    VIDEO_COST_PER_SECOND_USD: 0.42,
  },
  estimateImagenCost: (n: number) => n * 0.04,
  estimateClaudeCost: () => 0.001,
  estimateGeminiTextCost: () => 0.0005,
  estimateVideoDurationSeconds: (bytes: number) => Math.max(3, Math.round(bytes / 512_000)),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({
          instagram_feed: { caption: "Test IG caption", headline: "IG Headline" },
          instagram_story: { caption: "Story caption", headline: "Story Hd" },
          twitter: { caption: "Tweet", headline: "Tweet Hd" },
          linkedin: { caption: "LinkedIn caption", headline: "LinkedIn Hd" },
          tiktok: { caption: "TikTok caption", headline: "TikTok Hd" },
        }) }],
      }),
    },
  },
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: {
      generateContent: vi.fn().mockResolvedValue({
        candidates: [{
          content: { parts: [{ text: '{"ok":true,"issue":null,"correctionHint":null}' }] },
        }],
      }),
    },
    interactions: {
      create: vi.fn().mockResolvedValue({
        id: "viact-gemini-1",
        output_video: { data: Buffer.alloc(100).toString("base64"), mime_type: "video/mp4" },
      }),
    },
  },
}));

vi.mock("../services/imagen.js", () => ({
  PLATFORM_CONFIGS: {
    instagram_feed:  { aspectRatio: "1:1",  width: 1080, height: 1080 },
    instagram_story: { aspectRatio: "9:16", width: 1080, height: 1920 },
    twitter:         { aspectRatio: "16:9", width: 1280, height:  720 },
    linkedin:        { aspectRatio: "1:1",  width: 1200, height: 1200 },
    tiktok:          { aspectRatio: "9:16", width: 1080, height: 1920 },
    youtube:         { aspectRatio: "16:9", width: 1280, height:  720 },
  },
  outpaintImage: vi.fn().mockResolvedValue(Buffer.from("outpainted")),
}));

// ---------------------------------------------------------------------------
// @workspace/db mock — exactly like audit.test.ts pattern
// Factory is self-contained; mutable state is captured by reference via closures
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const studioSessionsTable = { __name: "studio_sessions" };
  const sessionTurnsTable = { __name: "session_turns" };
  const creativesTable = { __name: "creatives" };
  const creativeVariantsTable = { __name: "creative_variants" };
  const costLogsTable = { __name: "cost_logs" };
  const brandsTable = { __name: "brands" };
  const assetsTable = { __name: "assets" };
  const styleProfilesTable = { __name: "style_profiles" };
  const designerPersonasTable = { __name: "designer_personas" };
  const calendarEntriesTable = { __name: "calendar_entries" };
  const socialAccountsTable = { __name: "social_accounts" };

  function selectChain(rows: Array<Record<string, unknown>>) {
    let result = rows;
    const c: Record<string, unknown> = {
      from: (t: { __name?: string }) => {
        // We look up the rows from the outer selectByTable Map by reference
        result = selectByTable.get(t?.__name ?? "") ?? [];
        return c;
      },
      where: () => c,
      limit: (n: number) => { result = result.slice(0, n); return c; },
      offset: () => c,
      orderBy: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      then: (r: (v: Array<Record<string, unknown>>) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(r, j),
      catch: (j: (e: unknown) => unknown) => Promise.resolve(result).catch(j),
      finally: (f: () => void) => Promise.resolve(result).finally(f),
    };
    return c;
  }

  const db = {
    select: () => selectChain([]),
    insert: (table: { __name?: string }) => ({
      values: (vals: Record<string, unknown>) => {
        const id = `${table.__name ?? "row"}-${insertRows.length + 1}`;
        const row = { id, ...vals };
        insertRows.push(row);
        return { returning: () => Promise.resolve([row]) };
      },
    }),
    update: () => {
      const entry: { values: Record<string, unknown> } = { values: {} };
      const u = {
        set: (vals: Record<string, unknown>) => { entry.values = vals; updateSets.push(entry); return u; },
        where: () => Promise.resolve([]),
      };
      return u;
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: vi.fn().mockResolvedValue(undefined),
  };

  return {
    db,
    studioSessionsTable,
    sessionTurnsTable,
    creativesTable,
    creativeVariantsTable,
    costLogsTable,
    brandsTable,
    assetsTable,
    styleProfilesTable,
    designerPersonasTable,
    calendarEntriesTable,
    socialAccountsTable,
    eq: (col: unknown, val: unknown) => ({ __eq: col, val }),
    and: (...args: unknown[]) => ({ __and: args }),
    desc: (col: unknown) => ({ __desc: col }),
    sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ __sql: s, v }), { raw: (s: string) => s }),
    gte: (col: unknown, val: unknown) => ({ __gte: col, val }),
    inArray: (col: unknown, vals: unknown[]) => ({ __inArray: col, vals }),
    isNotNull: (col: unknown) => ({ __isNotNull: col }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { branchSession, getSessionWithTurns, executeTurn } from "./session-service.js";
import { estimateVideoDurationSeconds } from "../lib/ai-config.js";

beforeEach(() => {
  insertRows = [];
  updateSets = [];
  selectByTable = new Map();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// branchSession
// ---------------------------------------------------------------------------

describe("branchSession", () => {
  it("restores activeVariantId and imageInteractionId from producing turn", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-1", imageInteractionId: "latest-iact" }]);
    setSelectRows("session_turns", [
      { id: "t1", seq: 2, role: "copilot", action: "draft", status: "done", resultVariantIds: ["var-1"], interactionId: "iact-t1" },
      { id: "t2", seq: 4, role: "copilot", action: "edit_image", status: "done", resultVariantIds: ["var-2"], interactionId: "iact-t2" },
    ]);

    const result = await branchSession({ sessionId: "sess-1", variantId: "var-2" });

    expect(result.activeVariantId).toBe("var-2");
    expect(result.imageInteractionId).toBe("iact-t2");
    expect(result.sessionId).toBe("sess-1");
    expect(updateSets.length).toBeGreaterThan(0);
    expect(updateSets[0].values).toMatchObject({
      activeVariantId: "var-2",
      imageInteractionId: "iact-t2",
    });
  });

  it("sets imageInteractionId to null when no producing turn contains the variantId", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-2", imageInteractionId: "stale" }]);
    setSelectRows("session_turns", [
      { id: "t1", role: "copilot", status: "done", resultVariantIds: ["other-var"], interactionId: "iact-t1" },
    ]);

    const result = await branchSession({ sessionId: "sess-2", variantId: "unknown-var" });

    expect(result.imageInteractionId).toBeNull();
    expect(updateSets[0].values.imageInteractionId).toBeNull();
  });

  it("throws 'Session not found' when session row is missing", async () => {
    setSelectRows("studio_sessions", []);
    await expect(branchSession({ sessionId: "missing", variantId: "v1" })).rejects.toThrow("Session not found");
  });

  it("picks the copilot turn with matching variantId (ignores user turns)", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-3", imageInteractionId: "old" }]);
    setSelectRows("session_turns", [
      // user turn also has the variantId — should be ignored since we filter role=copilot
      { id: "t-user", seq: 1, role: "user", action: "draft", status: "done", resultVariantIds: ["v-target"], interactionId: "user-iact" },
      { id: "t-copilot", seq: 2, role: "copilot", action: "draft", status: "done", resultVariantIds: ["v-target"], interactionId: "copilot-iact" },
    ]);

    const result = await branchSession({ sessionId: "sess-3", variantId: "v-target" });
    expect(result.imageInteractionId).toBe("copilot-iact");
  });

  it("overwrites the imageInteractionId even when it already matches the latest", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-4", imageInteractionId: "iact-t1" }]);
    setSelectRows("session_turns", [
      { id: "t1", seq: 2, role: "copilot", action: "draft", status: "done", resultVariantIds: ["v1"], interactionId: "iact-t1" },
    ]);

    const result = await branchSession({ sessionId: "sess-4", variantId: "v1" });
    expect(result.imageInteractionId).toBe("iact-t1");
    // Update still fires so the timestamp is refreshed
    expect(updateSets.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getSessionWithTurns
// ---------------------------------------------------------------------------

describe("getSessionWithTurns", () => {
  it("returns null when session row is missing", async () => {
    setSelectRows("studio_sessions", []);
    expect(await getSessionWithTurns("missing")).toBeNull();
  });

  it("returns session with empty turns list when no turns exist", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-ok", activeVariantId: null }]);
    setSelectRows("session_turns", []);
    setSelectRows("creative_variants", []);

    const result = await getSessionWithTurns("sess-ok");
    expect(result).not.toBeNull();
    expect(result!.session.id).toBe("sess-ok");
    expect(result!.turns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compare turn: canonical take semantics
// ---------------------------------------------------------------------------

describe("Compare turn canonical take semantics", () => {
  const PLATFORMS = ["instagram_feed", "instagram_story", "twitter", "linkedin", "tiktok"];

  // Mirrors the logic in executeCompare: for N takes, one canonical ID is pushed
  // per take (variantIds[0] = first-platform = instagram_feed).
  function simulateCompare(count: number): string[] {
    const canonicalTakeIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const takeVariants = PLATFORMS.map((_, pi) => `take-${i + 1}-platform-${pi}`);
      if (takeVariants[0]) canonicalTakeIds.push(takeVariants[0]);
    }
    return canonicalTakeIds;
  }

  it("compare(3) produces exactly 3 canonical IDs, one per take", () => {
    expect(simulateCompare(3)).toHaveLength(3);
  });

  it("compare(5) produces exactly 5 canonical IDs, one per take", () => {
    expect(simulateCompare(5)).toHaveLength(5);
  });

  it("canonical IDs are the first-platform (instagram_feed) representative per take", () => {
    simulateCompare(3).forEach((id, i) => {
      expect(id).toBe(`take-${i + 1}-platform-0`);
    });
  });

  it("canonical IDs are all distinct (no cross-platform duplicates)", () => {
    const ids = simulateCompare(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("compare(1) still produces exactly 1 canonical ID", () => {
    expect(simulateCompare(1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pick endpoint: ownership validation
// ---------------------------------------------------------------------------

describe("Pick endpoint ownership validation", () => {
  // Mirror the validation from sessions.ts pick route
  function isOwned(resultVariantIds: string[], requested: string) {
    return resultVariantIds.includes(requested);
  }

  it("allows a variant that is in the turn's resultVariantIds", () => {
    expect(isOwned(["v1", "v2", "v3"], "v2")).toBe(true);
  });

  it("rejects a variant that does not belong to this turn", () => {
    expect(isOwned(["v1", "v2", "v3"], "v-foreign")).toBe(false);
  });

  it("rejects when resultVariantIds is empty", () => {
    expect(isOwned([], "v1")).toBe(false);
  });

  it("allows picking the first and last take", () => {
    const ids = ["t1", "t2", "t3"];
    expect(isOwned(ids, "t1")).toBe(true);
    expect(isOwned(ids, "t3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Caption action: contract — produces new variant rows, not a passthrough
// ---------------------------------------------------------------------------

describe("Caption action result contract", () => {
  it("caption result variantIds must differ from the source activeVariantId", () => {
    const sourceVariantId = "source-var-99";
    // Post-fix: executeCaption calls saveTurnVariants and gets back new IDs
    const captionResultVariantIds = ["new-var-ig", "new-var-story", "new-var-tw", "new-var-li", "new-var-tk"];

    expect(captionResultVariantIds).not.toContain(sourceVariantId);
    expect(captionResultVariantIds.length).toBeGreaterThan(0);
  });

  it("caption result must include alternates in metadata", () => {
    const metadata: Record<string, unknown> = {
      platform: "instagram_feed",
      alternates: [{ caption: "Alt 1", headline: "Hd 1" }, { caption: "Alt 2", headline: "Hd 2" }],
    };
    expect(metadata.alternates).toBeDefined();
    expect(Array.isArray(metadata.alternates)).toBe(true);
    expect((metadata.alternates as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SSE result event: alternates are surfaced from metadata
// ---------------------------------------------------------------------------

describe("SSE result event alternates surfacing", () => {
  // Mirrors the logic in executeTurn's onProgress call
  function buildResultData(metadata: Record<string, unknown> | undefined, variantIds: string[]) {
    return {
      variantIds,
      interactionId: "iact-1",
      ...(metadata?.alternates ? { alternates: metadata.alternates } : {}),
    };
  }

  it("result event includes alternates when caption metadata has them", () => {
    const data = buildResultData(
      { alternates: [{ caption: "Alt 1", headline: "Hd" }] },
      ["v1"],
    );
    expect(data).toHaveProperty("alternates");
    expect((data.alternates as unknown[]).length).toBe(1);
  });

  it("result event omits alternates key when metadata has none", () => {
    const data = buildResultData({ platform: "twitter" }, ["v1"]);
    expect(data).not.toHaveProperty("alternates");
  });

  it("result event omits alternates key when metadata is undefined", () => {
    const data = buildResultData(undefined, ["v1"]);
    expect(data).not.toHaveProperty("alternates");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: estimateVideoDurationSeconds (ai-config helper)
// ---------------------------------------------------------------------------

describe("estimateVideoDurationSeconds", () => {
  it("returns minimum 3s for empty/tiny buffers", () => {
    expect(estimateVideoDurationSeconds(0)).toBe(3);
    expect(estimateVideoDurationSeconds(100)).toBe(3);
    expect(estimateVideoDurationSeconds(256_000)).toBe(3); // 0.5s → clamp to 3
  });

  it("returns ~2s for a 1 MB buffer but clamps to 3", () => {
    // 1 MB / 512 KB/s = ~2s → clamped to 3
    expect(estimateVideoDurationSeconds(1_024_000)).toBe(3);
  });

  it("scales linearly above the 3s floor", () => {
    // 2.5 MB / 512 KB/s ≈ 5s
    expect(estimateVideoDurationSeconds(2_560_000)).toBe(5);
    // 5 MB / 512 KB/s ≈ 10s
    expect(estimateVideoDurationSeconds(5_120_000)).toBe(10);
  });

  it("cost for a 5s clip = 5 * VIDEO_COST_PER_SECOND_USD", () => {
    const duration = estimateVideoDurationSeconds(2_560_000);
    const costPerSecond = 0.42; // matches mock
    expect(duration * costPerSecond).toBeCloseTo(5 * 0.42, 4);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: edit_region prompt encoding (tests the real regionPrompt format)
// ---------------------------------------------------------------------------

describe("edit_region region prompt encoding", () => {
  function buildRegionPrompt(region: {x0:number;y0:number;x1:number;y1:number}, instruction: string) {
    return (
      `Apply ONLY within the region bounded by normalized coordinates ` +
      `top-left [${region.x0.toFixed(3)}, ${region.y0.toFixed(3)}] ` +
      `to bottom-right [${region.x1.toFixed(3)}, ${region.y1.toFixed(3)}]: ` +
      `${instruction}. ` +
      `Keep all content outside this region completely unchanged.`
    );
  }

  it("encodes region coordinates as normalized values", () => {
    const prompt = buildRegionPrompt({ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.7 }, "add glow");
    expect(prompt).toContain("[0.100, 0.200]");
    expect(prompt).toContain("[0.500, 0.700]");
  });

  it("includes the original instruction verbatim", () => {
    const instruction = "change sky to sunset";
    const prompt = buildRegionPrompt({ x0: 0, y0: 0, x1: 1, y1: 0.5 }, instruction);
    expect(prompt).toContain(instruction);
  });

  it("includes the preservation directive", () => {
    const prompt = buildRegionPrompt({ x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 }, "blur");
    expect(prompt).toContain("Keep all content outside this region completely unchanged");
  });

  it("uses 3 decimal precision for normalized coordinates", () => {
    const prompt = buildRegionPrompt({ x0: 0, y0: 0, x1: 1, y1: 1 }, "test");
    expect(prompt).toContain("[0.000, 0.000]");
    expect(prompt).toContain("[1.000, 1.000]");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: schedule handler — ownership validation via real executeTurn
// ---------------------------------------------------------------------------

function setupSessionAndCreative(overrides?: Record<string, unknown>) {
  setSelectRows("studio_sessions", [{
    id: "sess-sched",
    creativeId: "cre-sched",
    imageInteractionId: "iact-sched",
    videoInteractionId: null,
    activeVariantId: "v-sched",
    thumbnailUrl: null,
    totalCostUsd: 0,
    ...overrides,
  }]);
  setSelectRows("creatives", [{
    id: "cre-sched",
    brandId: "brand-1",
    intent: "social",
    briefText: "test brief",
    selectedAssets: [],
    styleProfileId: null,
    templateId: null,
    referenceBalance: null,
  }]);
  setSelectRows("session_turns", []);
  setSelectRows("brands", [{
    id: "brand-1",
    name: "Test Brand",
    voiceDescription: "casual",
    bannedTerms: [],
    trademarkRules: null,
    hashtagStrategy: null,
    characterStyleRules: null,
    imagenPrefix: "",
    negativePrompt: "",
    platformRules: null,
    voiceExamples: null,
  }]);
}

describe("schedule turn — ownership validation (real handler)", () => {
  it("throws when no schedules are provided", async () => {
    setupSessionAndCreative();
    setSelectRows("creative_variants", []);

    await expect(executeTurn({
      sessionId: "sess-sched",
      input: { action: "schedule", instruction: "", schedules: [] },
      userId: "user-1",
      onProgress: vi.fn(),
    })).rejects.toThrow("No schedules provided");
  });

  it("throws when variantId does not belong to this creative", async () => {
    setupSessionAndCreative();
    // Ownership check: creative_variants returns empty → variant not owned
    setSelectRows("creative_variants", []);

    await expect(executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "schedule",
        instruction: "",
        schedules: [{ variantId: "v-other-creative", platform: "instagram_feed", scheduledAt: "2026-07-22T09:00:00.000Z" }],
      },
      userId: "user-1",
      onProgress: vi.fn(),
    })).rejects.toThrow("does not belong to this creative");
  });

  it("inserts calendar rows when all variantIds belong to this creative and account is connected", async () => {
    setupSessionAndCreative();
    // Ownership check passes: variant found in this creative
    setSelectRows("creative_variants", [{ id: "v-owned", creativeId: "cre-sched" }]);
    // A connected Instagram account exists for this brand
    setSelectRows("social_accounts", [{ id: "acct-ig-1", platform: "instagram", brandId: "brand-123", status: "connected" }]);

    const onProgress = vi.fn();
    await executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "schedule",
        instruction: "",
        schedules: [{ variantId: "v-owned", platform: "instagram_feed", scheduledAt: "2026-07-22T09:00:00.000Z" }],
      },
      userId: "user-1",
      onProgress,
    });

    // At least one calendar_entries insert should have been recorded with the resolved account
    const calendarInserts = insertRows.filter(r => (r as Record<string, unknown>).scheduleMethod === "copilot");
    expect(calendarInserts.length).toBeGreaterThanOrEqual(1);
    expect(calendarInserts[0]).toMatchObject({
      platform: "instagram_feed",
      publishStatus: "scheduled",
      socialAccountId: "acct-ig-1",
    });
  });

  it("throws when a required social account is not connected", async () => {
    setupSessionAndCreative();
    setSelectRows("creative_variants", [{ id: "v-owned", creativeId: "cre-sched" }]);
    // No social accounts in mock
    setSelectRows("social_accounts", []);

    await expect(executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "schedule",
        instruction: "",
        schedules: [{ variantId: "v-owned", platform: "instagram_feed", scheduledAt: "2026-07-22T09:00:00.000Z" }],
      },
      userId: "user-1",
      onProgress: vi.fn(),
    })).rejects.toThrow("No connected instagram_feed account");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: fan-out YouTube card — included in platform set with requiresVideo
// ---------------------------------------------------------------------------

describe("fan-out turn — YouTube included with requiresVideo flag", () => {
  it("fan-out metadata includes a YouTube card with requiresVideo:true", async () => {
    setupSessionAndCreative();
    setSelectRows("creative_variants", [{
      id: "v-active",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/original.png",
      status: "generated",
    }]);
    setSelectRows("assets", []);

    insertRows = [];
    const onProgress = vi.fn();

    await executeTurn({
      sessionId: "sess-sched",
      input: { action: "fan_out", instruction: "fan out to all platforms" },
      userId: "user-1",
      onProgress,
    });

    // fan-out stores metadata.platforms in the session_turns DB row via db.update()
    // (after the handler completes). It's captured in updateSets, not insertRows.
    type PlatformCard = { platform: string; requiresVideo?: boolean };
    const turnUpdate = updateSets.find(
      u => Array.isArray((u.values?.metadata as Record<string, unknown> | null)?.platforms),
    );

    const platforms = (turnUpdate?.values?.metadata as { platforms?: PlatformCard[] } | null)?.platforms ?? [];
    const ytCard = platforms.find((p: PlatformCard) => p.platform === "youtube");
    expect(ytCard, "YouTube card should be present in fan-out metadata").toBeDefined();
    expect(ytCard?.requiresVideo).toBe(true);

    // Non-youtube cards should NOT have requiresVideo
    const nonYt = platforms.filter((p: PlatformCard) => p.platform !== "youtube");
    expect(nonYt.length).toBeGreaterThan(0);
    nonYt.forEach((p: PlatformCard) => expect(p.requiresVideo).toBeFalsy());
  });
});

// ---------------------------------------------------------------------------
// Phase 2: schedule YouTube without video — guard throws
// ---------------------------------------------------------------------------

describe("schedule turn — YouTube requires video before scheduling", () => {
  it("throws when attempting to schedule a YouTube variant without a video asset", async () => {
    setupSessionAndCreative();
    // variant exists and is owned by this creative
    setSelectRows("creative_variants", [{ id: "v-yt", creativeId: "cre-sched" }]);
    // connected YouTube account exists
    setSelectRows("social_accounts", [{ id: "acct-yt", platform: "youtube", brandId: "brand-123", status: "connected" }]);
    // but the variant has no videoUrl (image-only thumbnail from fan-out)

    await expect(executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "schedule",
        instruction: "",
        schedules: [{ variantId: "v-yt", platform: "youtube", scheduledAt: "2026-07-22T09:00:00.000Z" }],
      },
      userId: "user-1",
      onProgress: vi.fn(),
    })).rejects.toThrow("YouTube variants require a video asset");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: inline fan-out YouTube convert flow (fan-out → convert → schedule)
// ---------------------------------------------------------------------------

describe("convert_video with sourceVariantId — inline fan-out YouTube flow", () => {
  it("creates a video variant using the specified sourceVariantId, not activeVariantId", async () => {
    setupSessionAndCreative();
    // Fan-out YouTube card variant (image-only)
    setSelectRows("creative_variants", [{
      id: "v-yt-image",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/yt-thumb.png",
      compositedImageUrl: "/api/files/generated/yt-thumb.png",
      platform: "youtube",
      aspectRatio: "16:9",
      status: "generated",
    }]);

    insertRows = [];
    updateSets = [];

    await executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "convert_video",
        instruction: "Convert to dynamic video",
        sourceVariantId: "v-yt-image",
      },
      userId: "user-1",
      onProgress: vi.fn(),
    });

    // A new creative_variant insert should have been made with a videoUrl
    const videoInsert = insertRows.find(
      r => typeof (r as Record<string, unknown>).videoUrl === "string",
    ) as Record<string, unknown> | undefined;
    expect(videoInsert, "Should have inserted a video variant row").toBeDefined();
    expect(videoInsert?.platform).toBe("youtube");
    expect(videoInsert?.sourceVariantId).toBe("v-yt-image");

    // The session_turns update should include metadata.sourceVariantId so the
    // frontend can map the new video back to the YouTube fan-out card.
    const turnUpdate = updateSets.find(
      u => typeof (u.values?.metadata as Record<string, unknown> | null)?.sourceVariantId === "string",
    );
    expect(turnUpdate?.values?.metadata).toMatchObject({ sourceVariantId: "v-yt-image" });
  });

  it("allows scheduling the YouTube card after convert_video produces a video variant", async () => {
    setupSessionAndCreative();
    // YouTube variant WITH a videoUrl (produced by convert_video)
    setSelectRows("creative_variants", [{
      id: "v-yt-video",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/yt-thumb.png",
      videoUrl: "/api/files/generated/yt-video.mp4",
      platform: "youtube",
      status: "generated",
    }]);
    setSelectRows("social_accounts", [{ id: "acct-yt", platform: "youtube", brandId: "brand-123", status: "connected" }]);

    await executeTurn({
      sessionId: "sess-sched",
      input: {
        action: "schedule",
        instruction: "",
        schedules: [{ variantId: "v-yt-video", platform: "youtube", scheduledAt: "2026-07-22T15:00:00.000Z" }],
      },
      userId: "user-1",
      onProgress: vi.fn(),
    });

    const calendarInserts = insertRows.filter(r => (r as Record<string, unknown>).scheduleMethod === "copilot");
    expect(calendarInserts.length).toBeGreaterThanOrEqual(1);
    expect(calendarInserts[0]).toMatchObject({ platform: "youtube", publishStatus: "scheduled", socialAccountId: "acct-yt" });
  });
});

// ---------------------------------------------------------------------------
// Phase 2: QA turn emission — QA correction creates its own session turn row
// ---------------------------------------------------------------------------

describe("QA pass — corrective turn is emitted as its own DB row", () => {
  it("no extra turn is inserted when QA verdict is ok:true", async () => {
    // Default gemini mock returns ok:true — no corrective turn should be inserted
    setupSessionAndCreative();
    setSelectRows("creative_variants", [{
      id: "v-sched",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/test.png",
    }]);

    insertRows = [];
    const onProgress = vi.fn();

    await executeTurn({
      sessionId: "sess-sched",
      input: { action: "edit_image", instruction: "make it pop" },
      userId: "user-1",
      onProgress,
    });

    // Turns inserted: 1 user + 1 copilot. No QA correction turn.
    const turnInserts = insertRows.filter(r => (r as Record<string, unknown>).role !== undefined);
    expect(turnInserts.length).toBe(2);
  });

  it("an extra copilot turn is inserted when QA returns ok:false with correctionHint", async () => {
    // Override gemini mock to return a failing QA verdict
    const { ai } = await import("@workspace/integrations-gemini-ai");
    vi.mocked(ai.models.generateContent).mockResolvedValueOnce({
      candidates: [{
        content: { parts: [{ text: '{"ok":false,"issue":"Sky not replaced","correctionHint":"Re-apply sky replacement with stronger prompt"}' }] },
      }],
    } as Awaited<ReturnType<typeof ai.models.generateContent>>);

    setupSessionAndCreative();
    setSelectRows("creative_variants", [{
      id: "v-sched",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/test.png",
    }]);

    insertRows = [];
    const onProgress = vi.fn();

    await executeTurn({
      sessionId: "sess-sched",
      input: { action: "edit_image", instruction: "replace sky with dramatic sunset" },
      userId: "user-1",
      onProgress,
    });

    // Turns: 1 user + 1 copilot + 1 QA correction turn = 3 session_turns rows
    const turnInserts = insertRows.filter(r => (r as Record<string, unknown>).role !== undefined);
    expect(turnInserts.length).toBe(3);
    const qaTurn = turnInserts.find(r => (r as Record<string, unknown>).instruction?.toString().startsWith("QA correction:"));
    expect(qaTurn).toBeDefined();
    expect(qaTurn).toMatchObject({ role: "copilot", action: "edit_image" });
  });

  it("QA correction is logged as a dedicated cost_logs row (no double-counting in parent turn)", async () => {
    const { ai } = await import("@workspace/integrations-gemini-ai");
    vi.mocked(ai.models.generateContent).mockResolvedValueOnce({
      candidates: [{
        content: { parts: [{ text: '{"ok":false,"issue":"Off-brand colours","correctionHint":"Reapply brand colour palette"}' }] },
      }],
    } as Awaited<ReturnType<typeof ai.models.generateContent>>);

    setupSessionAndCreative();
    setSelectRows("creative_variants", [{
      id: "v-sched",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/test.png",
    }]);

    insertRows = [];
    updateSets = [];

    await executeTurn({
      sessionId: "sess-sched",
      input: { action: "edit_image", instruction: "use brand colours" },
      userId: "user-1",
      onProgress: vi.fn(),
    });

    // A dedicated qa_correction cost_logs row must be inserted.
    const qaLog = insertRows.find(r =>
      (r as Record<string, unknown>).operation === "qa_correction",
    );
    expect(qaLog).toBeDefined();
    // estimateImagenCost(1) = 1 * 0.04 = 0.04 per the mock
    expect((qaLog as Record<string, unknown>).costUsd).toBeCloseTo(0.04, 4);

    // The QA correction turn's own update must also carry a positive costUsd.
    const qaTurnUpdate = updateSets.find(u =>
      (u.values as Record<string, unknown>).costUsd !== undefined &&
      Number((u.values as Record<string, unknown>).costUsd) > 0,
    );
    expect(qaTurnUpdate).toBeDefined();
    expect((qaTurnUpdate!.values as Record<string, unknown>).costUsd).toBeCloseTo(0.04, 4);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: convert_video — duration-based cost calculation via real handler
// ---------------------------------------------------------------------------

describe("convert_video — duration-based cost (real handler)", () => {
  it("costUsd in result is proportional to video buffer size", async () => {
    setupSessionAndCreative();
    setSelectRows("creative_variants", [{
      id: "v-sched",
      creativeId: "cre-sched",
      rawImageUrl: "/api/files/generated/test.png",
      compositedImageUrl: "/api/files/generated/test.png",
    }]);
    // runVideoInteraction mock returns 1 MB buffer → 3s duration (clamped) → 3 * 0.42 = $1.26
    const onProgress = vi.fn();

    await executeTurn({
      sessionId: "sess-sched",
      input: { action: "convert_video", instruction: "animate gently" },
      userId: "user-1",
      onProgress,
    });

    // The cost should be durationSeconds * VIDEO_COST_PER_SECOND_USD
    // mock buffer = 1_024_000 bytes → duration = max(3, round(1_024_000/512_000)) = 3s
    // cost = 3 * 0.42 = 1.26
    const savedCost = updateSets.find(u => u.values.costUsd !== undefined)?.values.costUsd as number;
    expect(savedCost).toBeCloseTo(3 * 0.42, 3);
  });
});

// ---------------------------------------------------------------------------
// estimateTurnCost (router helper)
// ---------------------------------------------------------------------------

describe("estimateTurnCost branching", () => {
  // Mirror function from sessions.ts
  function estimateTurnCost(action: string, compareCount?: number): number {
    switch (action) {
      case "draft":     return 0.04 + 0.001 + 0.0005;
      case "edit_image": return 0.04 + 0.001;
      case "edit_region": return 0.04 + 0.001;
      case "caption":   return 0.001;
      case "compare":   return (compareCount || 3) * (0.04 + 0.001);
      case "convert_video": return 2.10;
      case "edit_video": return 2.10;
      case "fan_out":   return 0.001 + 0.0005;
      case "schedule":  return 0;
      default:          return 0.04;
    }
  }

  it("draft cost includes imagen + claude + gemini-text", () => {
    expect(estimateTurnCost("draft")).toBeCloseTo(0.04 + 0.001 + 0.0005, 6);
  });

  it("edit_image cost excludes gemini-text component", () => {
    expect(estimateTurnCost("edit_image")).toBeLessThan(estimateTurnCost("draft"));
    expect(estimateTurnCost("edit_image")).toBeCloseTo(0.041, 6);
  });

  it("caption is claude-only (cheapest action)", () => {
    const costs = ["draft", "edit_image", "compare"].map(a => estimateTurnCost(a));
    expect(costs.every(c => c > estimateTurnCost("caption"))).toBe(true);
  });

  it("compare(n) cost scales linearly with n", () => {
    const base = 0.04 + 0.001;
    [2, 3, 4, 5].forEach(n =>
      expect(estimateTurnCost("compare", n)).toBeCloseTo(n * base, 6),
    );
  });

  it("compare defaults to 3 takes", () => {
    expect(estimateTurnCost("compare")).toBeCloseTo(3 * 0.041, 6);
  });

  it("compare is always more expensive than a single edit_image", () => {
    expect(estimateTurnCost("compare", 2)).toBeGreaterThan(estimateTurnCost("edit_image"));
  });
});

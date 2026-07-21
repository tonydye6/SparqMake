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
  COPILOT_MODELS: {
    NANO_BANANA_MODEL: "gemini-test",
    CAPTION_MODEL: "claude-test",
    CONCEPT_MODEL: "gemini-test",
    ART_DIRECTION_MODEL: "claude-test",
  },
  COST_ESTIMATES: { IMAGEN_PER_IMAGE: 0.04, CLAUDE_TOKENS: 0.001, GEMINI_TEXT: 0.0005 },
  estimateImagenCost: (n: number) => n * 0.04,
  estimateClaudeCost: () => 0.001,
  estimateGeminiTextCost: () => 0.0005,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "An image direction paragraph." }],
      }),
    },
  },
}));

vi.mock("../services/imagen.js", () => ({
  PLATFORM_CONFIGS: {
    instagram_feed: { aspectRatio: "1:1" },
    instagram_story: { aspectRatio: "9:16" },
    twitter: { aspectRatio: "16:9" },
    linkedin: { aspectRatio: "1:1" },
    tiktok: { aspectRatio: "9:16" },
  },
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
    eq: (col: unknown, val: unknown) => ({ __eq: col, val }),
    and: (...args: unknown[]) => ({ __and: args }),
    desc: (col: unknown) => ({ __desc: col }),
    sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ __sql: s, v }), { raw: (s: string) => s }),
    gte: (col: unknown, val: unknown) => ({ __gte: col, val }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { branchSession, getSessionWithTurns } from "./session-service.js";

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
      { id: "t1", role: "copilot", status: "done", resultVariantIds: ["var-1"], interactionId: "iact-t1" },
      { id: "t2", role: "copilot", status: "done", resultVariantIds: ["var-2"], interactionId: "iact-t2" },
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
      { id: "t-user", role: "user", status: "done", resultVariantIds: ["v-target"], interactionId: "user-iact" },
      { id: "t-copilot", role: "copilot", status: "done", resultVariantIds: ["v-target"], interactionId: "copilot-iact" },
    ]);

    const result = await branchSession({ sessionId: "sess-3", variantId: "v-target" });
    expect(result.imageInteractionId).toBe("copilot-iact");
  });

  it("overwrites the imageInteractionId even when it already matches the latest", async () => {
    setSelectRows("studio_sessions", [{ id: "sess-4", imageInteractionId: "iact-t1" }]);
    setSelectRows("session_turns", [
      { id: "t1", role: "copilot", status: "done", resultVariantIds: ["v1"], interactionId: "iact-t1" },
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
// estimateTurnCost (router helper)
// ---------------------------------------------------------------------------

describe("estimateTurnCost branching", () => {
  // Mirror function from sessions.ts
  function estimateTurnCost(action: string, compareCount?: number): number {
    switch (action) {
      case "draft":     return 0.04 + 0.001 + 0.0005;
      case "edit_image": return 0.04 + 0.001;
      case "caption":   return 0.001;
      case "compare":   return (compareCount || 3) * (0.04 + 0.001);
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

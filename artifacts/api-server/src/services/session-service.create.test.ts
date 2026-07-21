import { describe, it, expect, vi, beforeEach } from "vitest";

// --- DB mock (chainable thenable, queued results per call) ---------------
let selectResults: unknown[][] = [];
let insertResults: unknown[][] = [];
let selectCall = 0;
let insertCall = 0;
let insertedValues: unknown[] = [];

function thenable(getResult: () => unknown[], onValues?: (v: unknown) => void) {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "returning", "set"]) obj[m] = () => obj;
  obj.values = (v: unknown) => { onValues?.(v); return obj; };
  (obj as { then: unknown }).then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(getResult()).then(resolve, reject);
  return obj;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => thenable(() => selectResults[selectCall++] ?? []),
    insert: () => thenable(() => insertResults[insertCall++] ?? [], (v) => insertedValues.push(v)),
  },
  studioSessionsTable: { id: "id", creativeId: "creative_id", updatedAt: "updated_at" },
  sessionTurnsTable: {},
  creativesTable: { id: "id", brandId: "brand_id" },
  creativeVariantsTable: {},
  costLogsTable: {},
  brandsTable: {},
  assetsTable: {},
  styleProfilesTable: {},
  designerPersonasTable: {},
  calendarEntriesTable: {},
  socialAccountsTable: {},
}));

vi.mock("./interactions-client.js", () => ({ runImageInteraction: vi.fn(), runVideoInteraction: vi.fn() }));
vi.mock("./claude.js", () => ({ generateCaptions: vi.fn() }));
vi.mock("./context-assembly.js", () => ({ assembleContext: vi.fn(), resolveStyleProfile: vi.fn(), resolveDesignerPersona: vi.fn() }));
vi.mock("./compositing.js", () => ({ compositeImage: vi.fn(), reframeImage: vi.fn(), imageDimensions: vi.fn() }));
vi.mock("./focal-point.js", () => ({ detectSubject: vi.fn(), predictClip: vi.fn() }));
vi.mock("./imagen.js", () => ({ outpaintImage: vi.fn(), PLATFORM_CONFIGS: {} }));
vi.mock("./performance-insights.js", () => ({ getIntentInsights: vi.fn() }));
vi.mock("./storage.js", () => ({ writeBuffer: vi.fn(), resolveUrl: vi.fn(), readBuffer: vi.fn(), contentTypeFor: vi.fn() }));
vi.mock("./packet-assembly.js", () => ({ buildGenerationPacket: vi.fn(), normalizeBalance: vi.fn(), MAX_IMAGE_REFERENCES: 3 }));
vi.mock("./taste-signals.js", () => ({ recordTasteSignal: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({ anthropic: {} }));
vi.mock("@workspace/integrations-gemini-ai", () => ({ ai: {} }));

const { createSession } = await import("./session-service.js");

beforeEach(() => {
  selectResults = [];
  insertResults = [];
  insertedValues = [];
  selectCall = 0;
  insertCall = 0;
});

const BRAND = "brand-1";
const CREATIVE = { id: "creative-1", brandId: BRAND, name: "Plan creative" };
const SESSION = { id: "session-1", creativeId: "creative-1", brandId: BRAND };

describe("createSession with existingCreativeId", () => {
  it("wraps the existing creative without inserting a new creatives row", async () => {
    selectResults = [[CREATIVE], []]; // creative lookup, no prior session
    insertResults = [[SESSION]];

    const session = await createSession({
      brandId: BRAND,
      briefText: "Brief",
      createdBy: "u1",
      existingCreativeId: "creative-1",
    });

    expect(session.creativeId).toBe("creative-1");
    // exactly one insert (the session) — no creative insert
    expect(insertedValues).toHaveLength(1);
    expect((insertedValues[0] as { creativeId: string }).creativeId).toBe("creative-1");
  });

  it("reuses an existing session for the creative on repeat opens", async () => {
    selectResults = [[CREATIVE], [SESSION]]; // creative lookup, prior session found

    const session = await createSession({
      brandId: BRAND,
      briefText: "Brief",
      createdBy: "u1",
      existingCreativeId: "creative-1",
    });

    expect(session.id).toBe("session-1");
    expect(insertedValues).toHaveLength(0); // no new session, no new creative
  });

  it("throws 'Creative not found' for an unknown creative id", async () => {
    selectResults = [[]];

    await expect(createSession({
      brandId: BRAND,
      briefText: "Brief",
      createdBy: "u1",
      existingCreativeId: "missing",
    })).rejects.toThrow("Creative not found");
    expect(insertedValues).toHaveLength(0);
  });

  it("throws on brand mismatch", async () => {
    selectResults = [[{ ...CREATIVE, brandId: "other-brand" }]];

    await expect(createSession({
      brandId: BRAND,
      briefText: "Brief",
      createdBy: "u1",
      existingCreativeId: "creative-1",
    })).rejects.toThrow("Creative does not belong to this brand");
    expect(insertedValues).toHaveLength(0);
  });

  it("still creates a fresh creative when existingCreativeId is absent", async () => {
    insertResults = [[CREATIVE], [SESSION]];

    const session = await createSession({
      brandId: BRAND,
      briefText: "Brief",
      createdBy: "u1",
    });

    expect(session.id).toBe("session-1");
    expect(insertedValues).toHaveLength(2); // creative + session
  });
});

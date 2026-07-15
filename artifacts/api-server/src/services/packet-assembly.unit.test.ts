import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Configurable per-test results -----------------------------------------
let selectReturn: unknown[] = [];
let packetLogInserts: Array<Record<string, unknown>> = [];

function selectChain() {
  const p = Promise.resolve(selectReturn);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => p.then(r, j),
    catch: (j: (e: unknown) => unknown) => p.catch(j),
    finally: (f: () => void) => p.finally(f),
  };
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => selectChain(),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        packetLogInserts.push(row);
        return Promise.resolve();
      },
    }),
  },
  assetsTable: { __name: "assets" },
  generationPacketLogsTable: { __name: "generation_packet_logs" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  inArray: () => ({}),
}));

const { buildGenerationPacket, normalizeBalance, MAX_IMAGE_REFERENCES } = await import(
  "./packet-assembly.js"
);

let idCounter = 0;
function makeAsset(overrides: Record<string, unknown> = {}) {
  idCounter++;
  return {
    id: `asset-${idCounter}`,
    brandId: "brand-1",
    name: `Asset ${idCounter}`,
    type: "image",
    assetClass: null,
    status: "approved",
    generationAllowed: true,
    compositingOnly: false,
    subjectIdentityScore: 3,
    styleStrengthScore: 3,
    freshnessScore: 3,
    referencePriorityDefault: 3,
    usageCount: 0,
    tags: [],
    depictedEntities: [],
    conflictTags: [],
    approvedTemplates: [],
    approvedChannels: [],
    franchise: null,
    ...overrides,
  };
}

const baseParams = {
  creativeId: "creative-1",
  brandId: "brand-1",
  templateId: "template-1",
  platform: "instagram",
};

beforeEach(() => {
  selectReturn = [];
  packetLogInserts = [];
  idCounter = 0;
});

describe("normalizeBalance", () => {
  it("passes through valid values and defaults the rest to balanced", () => {
    expect(normalizeBalance("subject")).toBe("subject");
    expect(normalizeBalance("style")).toBe("style");
    expect(normalizeBalance("balanced")).toBe("balanced");
    expect(normalizeBalance("nonsense")).toBe("balanced");
    expect(normalizeBalance(undefined)).toBe("balanced");
    expect(normalizeBalance(null)).toBe("balanced");
  });
});

describe("buildGenerationPacket slot plans", () => {
  it("balanced: attaches subjects and styles with the primary subject leading", async () => {
    const s1 = makeAsset({ subjectIdentityScore: 5 });
    const s2 = makeAsset({ subjectIdentityScore: 4 });
    const s3 = makeAsset({ subjectIdentityScore: 3 });
    const st1 = makeAsset({ assetClass: "style_reference", styleStrengthScore: 5 });
    const st2 = makeAsset({ assetClass: "style_reference", styleStrengthScore: 4 });
    selectReturn = [s1, s2, s3, st1, st2];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [s1.id, s2.id, s3.id, st1.id, st2.id],
      balance: "balanced",
      dryRun: true,
    });

    const attached = packet.generationAssets.slice(0, MAX_IMAGE_REFERENCES);
    // 6-slot budget: primary subject leads, then the style slots, then the
    // remaining subjects — all 5 candidates fit.
    expect(attached.map((a) => a.role)).toEqual([
      "subject_reference",
      "style_reference",
      "style_reference",
      "subject_reference",
      "subject_reference",
    ]);
    expect(attached[0].asset.id).toBe(s1.id);
    expect(attached[1].asset.id).toBe(st1.id);
  });

  it("style: reserves more slots for styles while the primary subject still leads", async () => {
    const s1 = makeAsset();
    const s2 = makeAsset();
    const st1 = makeAsset({ assetClass: "style_reference" });
    const st2 = makeAsset({ assetClass: "style_reference" });
    selectReturn = [s1, s2, st1, st2];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [s1.id, s2.id, st1.id, st2.id],
      balance: "style",
      dryRun: true,
    });

    const attached = packet.generationAssets.slice(0, MAX_IMAGE_REFERENCES);
    expect(attached.filter((a) => a.role === "style_reference")).toHaveLength(2);
    expect(attached.filter((a) => a.role === "subject_reference")).toHaveLength(2);
    expect(attached[0].role).toBe("subject_reference");
  });

  it("rolls unfillable style slots over to subjects", async () => {
    const s1 = makeAsset();
    const s2 = makeAsset();
    const s3 = makeAsset();
    selectReturn = [s1, s2, s3];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [s1.id, s2.id, s3.id],
      balance: "style",
      dryRun: true,
    });

    const attached = packet.generationAssets.slice(0, MAX_IMAGE_REFERENCES);
    expect(attached).toHaveLength(3);
    expect(attached.every((a) => a.role === "subject_reference")).toBe(true);
  });

  it("rolls unfillable subject slots over to styles", async () => {
    const st1 = makeAsset({ assetClass: "style_reference" });
    const st2 = makeAsset({ assetClass: "style_reference" });
    const st3 = makeAsset({ assetClass: "style_reference" });
    selectReturn = [st1, st2, st3];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [st1.id, st2.id, st3.id],
      balance: "subject",
      dryRun: true,
    });

    const attached = packet.generationAssets.slice(0, MAX_IMAGE_REFERENCES);
    expect(attached).toHaveLength(3);
    expect(attached.every((a) => a.role === "style_reference")).toBe(true);
  });
});

describe("brief-aware scoring", () => {
  it("boosts assets whose entities/tags match the brief above otherwise-stronger assets", async () => {
    const strong = makeAsset({ subjectIdentityScore: 4 });
    const matching = makeAsset({
      subjectIdentityScore: 1,
      depictedEntities: ["Mascot Dog"],
      tags: ["birthday"],
    });
    selectReturn = [strong, matching];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [strong.id, matching.id],
      briefText: "A birthday party post featuring the Mascot Dog on stage",
      balance: "balanced",
      dryRun: true,
    });

    expect(packet.generationAssets[0].asset.id).toBe(matching.id);
    const briefReason = packet.reasoning.selections.find((s) =>
      s.reason.includes("Brief match boost"),
    );
    expect(briefReason?.assetId).toBe(matching.id);
  });

  it("does not boost when brief text is absent", async () => {
    const strong = makeAsset({ subjectIdentityScore: 5 });
    const weak = makeAsset({ subjectIdentityScore: 1, depictedEntities: ["dog"] });
    selectReturn = [strong, weak];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [strong.id, weak.id],
      dryRun: true,
    });

    expect(packet.generationAssets[0].asset.id).toBe(strong.id);
  });
});

describe("overrides", () => {
  it("excludes removed assets and records the reason", async () => {
    const keep = makeAsset();
    const removed = makeAsset();
    selectReturn = [keep, removed];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [keep.id, removed.id],
      overrides: { removedAssetIds: [removed.id] },
      dryRun: true,
    });

    expect(packet.generationAssets.map((a) => a.asset.id)).toEqual([keep.id]);
    expect(packet.excludedAssets.map((a) => a.asset.id)).toContain(removed.id);
    expect(
      packet.reasoning.exclusions.find((e) => e.assetId === removed.id)?.reason,
    ).toMatch(/Removed by user/);
  });

  it("pinned assets outrank style-profile priority assets", async () => {
    const profileStyle = makeAsset({ assetClass: "style_reference", styleStrengthScore: 5 });
    const pinnedStyle = makeAsset({ assetClass: "style_reference", styleStrengthScore: 1 });
    selectReturn = [profileStyle, pinnedStyle];

    const packet = await buildGenerationPacket({
      ...baseParams,
      selectedAssetIds: [profileStyle.id, pinnedStyle.id],
      priorityStyleAssetIds: [profileStyle.id],
      overrides: { pinnedAssetIds: [pinnedStyle.id] },
      balance: "balanced",
      dryRun: true,
    });

    const styles = packet.generationAssets.filter((a) => a.role === "style_reference");
    expect(styles[0].asset.id).toBe(pinnedStyle.id);
  });
});

describe("dryRun packet log behavior", () => {
  it("skips the packet log when dryRun is true", async () => {
    const a = makeAsset();
    selectReturn = [a];
    await buildGenerationPacket({ ...baseParams, selectedAssetIds: [a.id], dryRun: true });
    expect(packetLogInserts).toHaveLength(0);
  });

  it("writes the packet log when dryRun is not set", async () => {
    const a = makeAsset();
    selectReturn = [a];
    await buildGenerationPacket({ ...baseParams, selectedAssetIds: [a.id] });
    expect(packetLogInserts).toHaveLength(1);
    expect(packetLogInserts[0].primaryAssetId).toBe(a.id);
  });
});

import { db, assetsTable, generationPacketLogsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import type { Asset } from "@workspace/db";

export interface GenerationPacket {
  generationAssets: PacketAsset[];
  compositingAssets: PacketAsset[];
  contextAssets: PacketAsset[];
  excludedAssets: PacketAsset[];
  reasoning: PacketReasoning;
}

export interface PacketAsset {
  asset: Asset;
  role: string;
  score: number;
}

export const MAX_GENERATION_ASSETS = 6;
export const MAX_IMAGE_REFERENCES = 3;

// Weighted reference system: how the attached image-reference slots are split
// between subject references and style references.
export type ReferenceBalance = "subject" | "balanced" | "style";

export interface ReferenceOverrides {
  removedAssetIds?: string[];
  pinnedAssetIds?: string[];
}

export function normalizeBalance(value: unknown): ReferenceBalance {
  return value === "subject" || value === "style" ? value : "balanced";
}

// Attached-slot plan per balance: how many of the MAX_IMAGE_REFERENCES slots
// are reserved for each role. Unfillable slots (not enough candidates of that
// role) fall back to the other role, so slots are never wasted.
const SLOT_PLANS: Record<ReferenceBalance, { subject: number; style: number }> = {
  subject: { subject: 2, style: 1 },
  balanced: { subject: 2, style: 1 },
  style: { subject: 1, style: 2 },
};

// Content-aware scoring: boost assets whose depicted entities / tags / name
// appear in the brief text, so the packet favors what the brief is about.
const BRIEF_ENTITY_MATCH_BOOST = 6;
const BRIEF_TAG_MATCH_BOOST = 3;

function briefMatchBoost(asset: Asset, briefLower: string | null): { boost: number; matches: string[] } {
  if (!briefLower) return { boost: 0, matches: [] };
  let boost = 0;
  const matches: string[] = [];
  for (const entity of asset.depictedEntities || []) {
    if (entity && entity.length >= 3 && briefLower.includes(entity.toLowerCase())) {
      boost += BRIEF_ENTITY_MATCH_BOOST;
      matches.push(entity);
    }
  }
  for (const tag of asset.tags || []) {
    if (tag && tag.length >= 3 && briefLower.includes(tag.toLowerCase())) {
      boost += BRIEF_TAG_MATCH_BOOST;
      matches.push(tag);
    }
  }
  if (asset.name && asset.name.length >= 3 && briefLower.includes(asset.name.toLowerCase())) {
    boost += BRIEF_TAG_MATCH_BOOST;
    matches.push(asset.name);
  }
  return { boost, matches: [...new Set(matches)] };
}

function scoreAsset(asset: Asset, role: string): number {
  let score = 0;

  if (role === "subject_reference") {
    score += (asset.subjectIdentityScore || 3) * 2;
    score += (asset.freshnessScore || 3);
  } else if (role === "style_reference") {
    score += (asset.styleStrengthScore || 3) * 2;
    score += (asset.freshnessScore || 3);
  } else {
    score += (asset.referencePriorityDefault || 3) * 2;
  }

  if (asset.status === "approved") score += 3;
  score += Math.min(asset.usageCount || 0, 5);

  return score;
}

function hasConflict(a: Asset, b: Asset): boolean {
  const aTags = a.conflictTags || [];
  const bTags = b.conflictTags || [];
  const bTagsSet = new Set(bTags);
  return aTags.some((tag: string) => bTagsSet.has(tag));
}

// Score boost applied to a selected style profile's reference assets so they
// always outrank organically-scored style candidates in packet assembly.
const STYLE_PROFILE_PRIORITY_BOOST = 1000;
// Pinned (user-chosen via influences preview) assets outrank everything,
// including style-profile references.
const PINNED_PRIORITY_BOOST = 10000;

export async function buildGenerationPacket(params: {
  creativeId: string;
  brandId: string;
  templateId: string;
  platform: string;
  selectedAssetIds: string[];
  franchise?: string;
  // Reference assets from the creative's selected style profile. These are
  // loaded even when not among selectedAssetIds and are treated as top-priority
  // style references.
  priorityStyleAssetIds?: string[];
  // Brief text: assets whose depicted entities/tags/name match the brief score
  // higher for this generation.
  briefText?: string | null;
  // Subject-vs-style slot balance (default "balanced").
  balance?: ReferenceBalance;
  // User overrides from the influences preview.
  overrides?: ReferenceOverrides | null;
  // When true, skip writing the packet log (used by the influences preview).
  dryRun?: boolean;
}): Promise<GenerationPacket> {
  const { creativeId, brandId, templateId, platform, selectedAssetIds, franchise } = params;
  const priorityStyleAssetIds = params.priorityStyleAssetIds || [];
  const prioritySet = new Set(priorityStyleAssetIds);
  const balance = normalizeBalance(params.balance);
  const removedSet = new Set(params.overrides?.removedAssetIds || []);
  const pinnedSet = new Set(params.overrides?.pinnedAssetIds || []);
  const briefLower = params.briefText ? params.briefText.toLowerCase() : null;

  const idsToLoad = [...new Set([...selectedAssetIds, ...priorityStyleAssetIds, ...pinnedSet])];
  let assets: Asset[] = [];
  if (idsToLoad.length > 0) {
    assets = await db.select().from(assetsTable)
      .where(and(
        inArray(assetsTable.id, idsToLoad),
        eq(assetsTable.brandId, brandId),
      ));
  }

  const generationAssets: PacketAsset[] = [];
  const compositingAssets: PacketAsset[] = [];
  const contextAssets: PacketAsset[] = [];
  const excludedAssets: PacketAsset[] = [];
  const reasoning: PacketReasoning = { selections: [], exclusions: [], strategy: "" };

  const subjectCandidates: PacketAsset[] = [];
  const styleCandidates: PacketAsset[] = [];

  for (const asset of assets) {
    if (removedSet.has(asset.id)) {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: "Removed by user in influences preview" });
      continue;
    }

    if (asset.status === "archived") {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: "Asset is archived" });
      continue;
    }

    if (asset.assetClass === "compositing" || asset.compositingOnly) {
      compositingAssets.push({ asset, role: "compositing", score: scoreAsset(asset, "compositing") });
      reasoning.selections.push({ assetId: asset.id, assetName: asset.name, role: "compositing", reason: "Asset classified as compositing-only" });
      continue;
    }

    if (asset.assetClass === "context" || asset.type === "context") {
      contextAssets.push({ asset, role: "context", score: scoreAsset(asset, "context") });
      reasoning.selections.push({ assetId: asset.id, assetName: asset.name, role: "context", reason: "Context asset provides brief/copy content" });
      continue;
    }

    if (!asset.generationAllowed) {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: "Generation not allowed for this asset" });
      continue;
    }

    if (asset.status !== "approved" && asset.status !== "uploaded") {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: `Asset status '${asset.status}' not eligible for generation` });
      continue;
    }

    const approvedTemplates = asset.approvedTemplates || [];
    if (approvedTemplates.length > 0 && !approvedTemplates.includes(templateId)) {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: `Not approved for template '${templateId}'` });
      continue;
    }

    const approvedChannels = asset.approvedChannels || [];
    if (approvedChannels.length > 0 && platform !== "all" && !approvedChannels.includes(platform)) {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: `Not approved for channel '${platform}'` });
      continue;
    }

    if (franchise && asset.franchise && asset.franchise !== franchise) {
      excludedAssets.push({ asset, role: "excluded", score: 0 });
      reasoning.exclusions.push({ assetId: asset.id, assetName: asset.name, reason: `Franchise mismatch: asset='${asset.franchise}', campaign='${franchise}'` });
      continue;
    }

    const isStyle = prioritySet.has(asset.id) || asset.assetClass === "style_reference";
    const role = isStyle ? "style_reference" : "subject_reference";
    const { boost: briefBoost, matches } = briefMatchBoost(asset, briefLower);
    let score = scoreAsset(asset, role) + briefBoost;
    if (prioritySet.has(asset.id)) score += STYLE_PROFILE_PRIORITY_BOOST;
    if (pinnedSet.has(asset.id)) score += PINNED_PRIORITY_BOOST;

    const candidate: PacketAsset = { asset, role, score };
    if (matches.length > 0) {
      reasoning.selections.push({
        assetId: asset.id,
        assetName: asset.name,
        role,
        reason: `Brief match boost (+${briefBoost}): ${matches.join(", ")}`,
      });
    }
    (isStyle ? styleCandidates : subjectCandidates).push(candidate);
  }

  subjectCandidates.sort((a, b) => b.score - a.score);
  styleCandidates.sort((a, b) => b.score - a.score);

  // --- Slot-based selection for the attached reference-image slots ---
  // The first MAX_IMAGE_REFERENCES generationAssets become attached images, so
  // ordering here IS the slot allocation. Each balance reserves slots per role;
  // slots a role can't fill roll over to the other role.
  const plan = SLOT_PLANS[balance];
  const picked = new Set<string>();

  function take(from: PacketAsset[], count: number, label: string): number {
    let taken = 0;
    for (const candidate of from) {
      if (taken >= count) break;
      if (picked.has(candidate.asset.id)) continue;
      if (generationAssets.length >= MAX_GENERATION_ASSETS) break;
      const noConflict = generationAssets.every(g => !hasConflict(g.asset, candidate.asset));
      if (!noConflict) continue;
      picked.add(candidate.asset.id);
      generationAssets.push(candidate);
      reasoning.selections.push({
        assetId: candidate.asset.id,
        assetName: candidate.asset.name,
        role: candidate.role,
        reason: `${label} (score: ${candidate.score})`,
      });
      taken++;
    }
    return taken;
  }

  // Primary subject always leads (keeps the subject recognizable), then style
  // slots, then remaining subject slots — so the guaranteed style slot(s)
  // survive into the attached set whenever style candidates exist.
  const subjectTakenFirst = take(subjectCandidates, Math.min(1, plan.subject), "Primary subject reference");
  const styleTaken = take(styleCandidates, plan.style, "Style reference slot");
  const remainingSubjectSlots = plan.subject - subjectTakenFirst
    // roll unfilled style slots over to subjects
    + (plan.style - styleTaken);
  take(subjectCandidates, remainingSubjectSlots, "Supporting subject reference");
  // roll unfilled subject slots over to extra style refs
  if (generationAssets.length < MAX_IMAGE_REFERENCES) {
    take(styleCandidates, MAX_IMAGE_REFERENCES - generationAssets.length, "Additional style reference");
  }

  // Beyond the attached slots, fill up to MAX_GENERATION_ASSETS with the rest
  // (they ride along as text descriptors).
  take([...subjectCandidates, ...styleCandidates].sort((a, b) => b.score - a.score), MAX_GENERATION_ASSETS - generationAssets.length, "Descriptor reference");

  reasoning.strategy = generationAssets.length === 0
    ? "No generation-eligible assets selected; text-only generation will be used"
    : `Selected ${generationAssets.length} generation asset(s) with '${balance}' balance: top ${Math.min(generationAssets.length, MAX_IMAGE_REFERENCES)} as reference image(s) (${generationAssets.slice(0, MAX_IMAGE_REFERENCES).map(g => g.role).join(", ")}), rest as text descriptors`;

  if (!params.dryRun) {
    try {
      await db.insert(generationPacketLogsTable).values({
        creativeId,
        platform,
        templateId,
        packetType: generationAssets.length > 0 ? "reference_guided" : "text_only",
        primaryAssetId: generationAssets[0]?.asset.id || null,
        supportingAssetIds: generationAssets.slice(1).map(a => a.asset.id),
        styleAssetIds: generationAssets.filter(a => a.role === "style_reference").map(a => a.asset.id),
        contextAssetIds: contextAssets.map(a => a.asset.id),
        compositingAssetIds: compositingAssets.map(a => a.asset.id),
        excludedAssetIds: excludedAssets.map(a => a.asset.id),
        packetReasoning: reasoning,
      });
    } catch (err) {
      console.error("Failed to log generation packet:", err instanceof Error ? err.message : err);
    }
  }

  return { generationAssets, compositingAssets, contextAssets, excludedAssets, reasoning };
}

export interface PacketReasoning {
  selections: Array<{ assetId: string; assetName: string; role: string; reason: string }>;
  exclusions: Array<{ assetId: string; assetName: string; reason: string }>;
  strategy: string;
}

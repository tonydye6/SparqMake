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

export interface PacketReasoning {
  selections: Array<{ assetId: string; assetName: string; role: string; reason: string }>;
  exclusions: Array<{ assetId: string; assetName: string; reason: string }>;
  strategy: string;
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
}): Promise<GenerationPacket> {
  const { creativeId, brandId, templateId, platform, selectedAssetIds, franchise } = params;
  const priorityStyleAssetIds = params.priorityStyleAssetIds || [];
  const prioritySet = new Set(priorityStyleAssetIds);

  const idsToLoad = [...new Set([...selectedAssetIds, ...priorityStyleAssetIds])];
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

    if (prioritySet.has(asset.id)) {
      // Style profile reference: always a style reference, boosted above any
      // organically-scored candidate so the chosen style dominates the packet.
      styleCandidates.push({ asset, role: "style_reference", score: STYLE_PROFILE_PRIORITY_BOOST + scoreAsset(asset, "style_reference") });
    } else if (asset.assetClass === "style_reference") {
      styleCandidates.push({ asset, role: "style_reference", score: scoreAsset(asset, "style_reference") });
    } else {
      subjectCandidates.push({ asset, role: "subject_reference", score: scoreAsset(asset, "subject_reference") });
    }
  }

  subjectCandidates.sort((a, b) => b.score - a.score);
  styleCandidates.sort((a, b) => b.score - a.score);

  if (subjectCandidates.length > 0) {
    const primary = subjectCandidates[0];
    generationAssets.push(primary);
    reasoning.selections.push({
      assetId: primary.asset.id,
      assetName: primary.asset.name,
      role: "subject_reference",
      reason: `Primary subject reference (score: ${primary.score})`,
    });
  }

  for (const style of styleCandidates) {
    if (generationAssets.length >= MAX_GENERATION_ASSETS) break;
    const noConflict = generationAssets.every(g => !hasConflict(g.asset, style.asset));
    if (noConflict) {
      generationAssets.push(style);
      reasoning.selections.push({
        assetId: style.asset.id,
        assetName: style.asset.name,
        role: "style_reference",
        reason: `Style reference (score: ${style.score})`,
      });
    }
  }

  if (generationAssets.length < MAX_GENERATION_ASSETS && subjectCandidates.length > 1) {
    for (let i = 1; i < subjectCandidates.length && generationAssets.length < MAX_GENERATION_ASSETS; i++) {
      const candidate = subjectCandidates[i];
      const noConflict = generationAssets.every(g => !hasConflict(g.asset, candidate.asset));
      if (noConflict) {
        generationAssets.push(candidate);
        reasoning.selections.push({
          assetId: candidate.asset.id,
          assetName: candidate.asset.name,
          role: "subject_reference",
          reason: `Supporting subject reference (score: ${candidate.score})`,
        });
      }
    }
  }

  reasoning.strategy = generationAssets.length === 0
    ? "No generation-eligible assets selected; text-only generation will be used"
    : `Selected ${generationAssets.length} generation asset(s): top ${Math.min(generationAssets.length, MAX_IMAGE_REFERENCES)} as reference image(s), rest as text descriptors (${generationAssets.map(g => g.role).join(", ")})`;

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

  return { generationAssets, compositingAssets, contextAssets, excludedAssets, reasoning };
}

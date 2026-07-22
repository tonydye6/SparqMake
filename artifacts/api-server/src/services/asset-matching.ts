import { db, assetsTable } from "@workspace/db";
import type { Asset } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";

export type MatchRole = "image_reference" | "text_description" | "compositing" | "context";

export interface AssetMatch {
  asset: Asset;
  score: number;
  role: MatchRole;
  matchedTerms: string[];
}

export interface MatchResult {
  imageReferences: AssetMatch[];
  textDescriptions: AssetMatch[];
  compositing: AssetMatch[];
  context: AssetMatch[];
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "by", "from", "up", "about", "into", "over", "after", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "will", "would", "should", "could", "may", "might", "must", "can",
  "this", "that", "these", "those", "it", "its", "we", "our", "you", "your",
  "as", "if", "so", "not", "no", "new", "make", "create", "post", "image",
  "photo", "picture", "show", "showing", "featuring", "using", "use",
]);

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s#@-]/g, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function stem(token: string): string {
  return token.replace(/(ing|ers|er|ies|es|s)$/, "");
}

function assetSearchText(asset: Asset): string {
  return [
    asset.name,
    asset.description || "",
    (asset.tags || []).join(" "),
    (asset.depictedEntities || []).join(" "),
    asset.styleNotes || "",
    asset.characterIdentityNote || "",
    asset.franchise || "",
    asset.content || "",
  ].join(" ");
}

/**
 * Tokenize a brief into the token+stem set scoreAssetAgainstBrief expects.
 * Exported for the Co-pilot creative director's asset catalog, which ranks
 * the whole library with the same scoring as this module's matcher.
 */
export function buildBriefTokenSet(briefText: string): Set<string> {
  const raw = tokenize(briefText);
  return new Set<string>([...raw, ...raw.map(stem)]);
}

export function scoreAssetAgainstBrief(asset: Asset, briefTokens: Set<string>): { score: number; matchedTerms: string[] } {
  const matched = new Set<string>();
  let score = 0;

  const weightedFields: Array<{ text: string; weight: number }> = [
    { text: (asset.depictedEntities || []).join(" "), weight: 3 },
    { text: (asset.tags || []).join(" "), weight: 2.5 },
    { text: asset.name, weight: 2 },
    { text: asset.characterIdentityNote || "", weight: 2 },
    { text: asset.description || "", weight: 1.5 },
    { text: asset.styleNotes || "", weight: 1 },
    { text: asset.franchise || "", weight: 1.5 },
    { text: asset.content || "", weight: 1 },
  ];

  for (const { text, weight } of weightedFields) {
    const tokens = tokenize(text);
    for (const token of tokens) {
      const s = stem(token);
      if (briefTokens.has(token) || briefTokens.has(s)) {
        if (!matched.has(s)) {
          matched.add(s);
          score += weight;
        } else {
          score += weight * 0.2;
        }
      }
    }
  }

  // Mild quality boosts so ties break toward curated assets.
  if (asset.status === "approved") score += 0.5;
  if (asset.aiAnalyzedAt) score += 0.25;
  score += Math.min(asset.usageCount || 0, 5) * 0.1;

  return { score, matchedTerms: [...matched] };
}

export async function matchAssetsToBrief(params: {
  brandId: string;
  briefText: string;
  maxImageRefs?: number;
  maxTextDescriptors?: number;
}): Promise<MatchResult> {
  const { brandId, briefText } = params;
  const maxImageRefs = params.maxImageRefs ?? 3;
  const maxTextDescriptors = params.maxTextDescriptors ?? 3;

  const rawTokens = tokenize(briefText);
  const briefTokens = new Set<string>([...rawTokens, ...rawTokens.map(stem)]);

  const assets = await db.select().from(assetsTable).where(and(
    eq(assetsTable.brandId, brandId),
    ne(assetsTable.status, "archived"),
  ));

  const scored: AssetMatch[] = [];
  for (const asset of assets) {
    const { score, matchedTerms } = scoreAssetAgainstBrief(asset, briefTokens);
    if (matchedTerms.length === 0) continue;
    scored.push({ asset, score, role: "text_description", matchedTerms });
  }
  scored.sort((a, b) => b.score - a.score);

  const compositing: AssetMatch[] = [];
  const context: AssetMatch[] = [];
  const generationEligible: AssetMatch[] = [];

  for (const match of scored) {
    const a = match.asset;
    if (a.assetClass === "compositing" || a.compositingOnly) {
      if (compositing.length < 2) compositing.push({ ...match, role: "compositing" });
      continue;
    }
    if (a.type === "context" || a.assetClass === "context") {
      if (context.length < 3) context.push({ ...match, role: "context" });
      continue;
    }
    if (a.type !== "visual") continue;
    if (a.generationAllowed === false) continue;
    if (!a.fileUrl || (a.mimeType || "").includes("video")) continue;
    generationEligible.push(match);
  }

  const imageReferences = generationEligible
    .slice(0, maxImageRefs)
    .map(m => ({ ...m, role: "image_reference" as MatchRole }));
  const textDescriptions = generationEligible
    .slice(maxImageRefs, maxImageRefs + maxTextDescriptors)
    .filter(m => !!(m.asset.description || m.asset.styleNotes))
    .map(m => ({ ...m, role: "text_description" as MatchRole }));

  return { imageReferences, textDescriptions, compositing, context };
}

import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS, estimateGeminiTextCost } from "../lib/ai-config.js";
import { db, assetsTable, costLogsTable } from "@workspace/db";
import type { Asset } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { resolveUrl, readBuffer } from "./storage.js";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface AssetAnalysisResult {
  description: string;
  kind: string;
  entities: string[];
  tags: string[];
  colors: string[];
  styleNotes: string;
  characterIdentityNote: string;
}

const KIND_TO_CLASS: Record<string, { assetClass: string; generationRole: string }> = {
  logo: { assetClass: "compositing", generationRole: "overlay" },
  character: { assetClass: "subject_reference", generationRole: "primary_subject" },
  mascot: { assetClass: "subject_reference", generationRole: "primary_subject" },
  person: { assetClass: "subject_reference", generationRole: "primary_subject" },
  product: { assetClass: "subject_reference", generationRole: "primary_subject" },
  scene: { assetClass: "style_reference", generationRole: "background" },
  background: { assetClass: "style_reference", generationRole: "background" },
  texture: { assetClass: "style_reference", generationRole: "background" },
  graphic: { assetClass: "style_reference", generationRole: "supporting" },
};

function buildPrompt(asset: Asset): string {
  return `You are an asset librarian for a sports marketing content platform.

Analyze the provided image (asset filename: "${asset.name}"). Return a JSON object with exactly these fields:

- "description": 1-2 sentences describing exactly what the image shows (subjects, setting, action, notable details). Be concrete and specific.
- "kind": one of "logo", "character", "mascot", "person", "product", "scene", "background", "texture", "graphic", "other"
- "entities": array of named or describable entities depicted (e.g. ["Rex the mascot", "football", "Crown U jersey #7"]). Empty array if none.
- "tags": array of 3-8 short lowercase search tags (e.g. ["football", "night game", "celebration"])
- "colors": array of 2-5 dominant colors as simple names or hex (e.g. ["navy blue", "#F5A623", "white"])
- "styleNotes": one sentence on visual style (e.g. "high-contrast dramatic stadium photography with cool tones")
- "characterIdentityNote": if kind is character/mascot/person, one sentence identifying who this is with distinguishing features for identity-consistent AI generation; otherwise empty string.

Return ONLY valid JSON, no markdown code blocks or extra text.`;
}

export async function analyzeAssetImage(asset: Asset): Promise<AssetAnalysisResult> {
  if (!asset.fileUrl) throw new Error("Asset has no file to analyze");
  const loc = resolveUrl(asset.fileUrl);
  if (!loc) throw new Error("Asset file location could not be resolved");
  const buffer = await readBuffer(loc);
  if (!buffer) throw new Error("Asset file could not be read from storage");
  if (buffer.length > MAX_FILE_SIZE_BYTES) throw new Error("Asset file exceeds 10MB analysis limit");

  const mimeType = asset.mimeType && asset.mimeType.startsWith("image/") ? asset.mimeType : "image/png";

  const response = await ai.models.generateContent({
    model: AI_MODELS.GEMINI_FLASH_TEXT,
    contents: [
      {
        role: "user",
        parts: [
          { text: buildPrompt(asset) },
          { inlineData: { data: buffer.toString("base64"), mimeType } },
        ],
      },
    ],
  });

  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part: { text?: string }) => part.text)
    .map((part: { text?: string }) => part.text)
    .join("") || "";

  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse asset analysis response: ${cleaned.slice(0, 200)}`);
  }

  const toStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(s => s.trim()).filter(Boolean) : [];

  return {
    description: typeof parsed.description === "string" ? parsed.description : "",
    kind: typeof parsed.kind === "string" ? parsed.kind.toLowerCase() : "other",
    entities: toStringArray(parsed.entities),
    tags: toStringArray(parsed.tags).map(t => t.toLowerCase()),
    colors: toStringArray(parsed.colors),
    styleNotes: typeof parsed.styleNotes === "string" ? parsed.styleNotes : "",
    characterIdentityNote: typeof parsed.characterIdentityNote === "string" ? parsed.characterIdentityNote : "",
  };
}

export function isAnalyzableAsset(asset: Asset): boolean {
  return asset.type === "visual"
    && !!asset.fileUrl
    && !(asset.mimeType || "").includes("video");
}

export async function analyzeAndStoreAsset(assetId: string): Promise<Asset> {
  const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, assetId));
  if (!asset) throw new Error("Asset not found");
  if (!isAnalyzableAsset(asset)) throw new Error("Asset is not an analyzable image");

  const analysis = await analyzeAssetImage(asset);

  const mergedTags = [...new Set([...(asset.tags || []), ...analysis.tags])];
  const updates: Record<string, unknown> = {
    description: analysis.description || asset.description,
    tags: mergedTags,
    depictedEntities: analysis.entities,
    colors: analysis.colors,
    styleNotes: analysis.styleNotes || null,
    aiAnalyzedAt: new Date(),
    updatedAt: new Date(),
  };

  const mapping = KIND_TO_CLASS[analysis.kind];
  if (mapping && !asset.assetClass) {
    updates.assetClass = mapping.assetClass;
    if (!asset.generationRole) updates.generationRole = mapping.generationRole;
    if (mapping.assetClass === "compositing") {
      updates.compositingOnly = true;
      updates.approvedForCompositing = true;
    }
  }
  if (analysis.characterIdentityNote && !asset.characterIdentityNote) {
    updates.characterIdentityNote = analysis.characterIdentityNote;
  }

  const [updated] = await db
    .update(assetsTable)
    .set(updates)
    .where(eq(assetsTable.id, assetId))
    .returning();

  try {
    await db.insert(costLogsTable).values({
      service: "gemini",
      operation: "asset_analysis",
      model: AI_MODELS.GEMINI_FLASH_TEXT,
      costUsd: estimateGeminiTextCost(),
    });
  } catch (err) {
    console.error("Failed to log asset analysis cost:", err instanceof Error ? err.message : err);
  }

  return updated;
}

export interface BackfillAnalysisResult {
  scanned: number;
  analyzed: number;
  failed: number;
  skipped: number;
  errors: Array<{ assetId: string; name: string; error: string }>;
}

export async function backfillAssetAnalysis(options?: {
  brandId?: string;
  force?: boolean;
  limit?: number;
}): Promise<BackfillAnalysisResult> {
  const conditions = [eq(assetsTable.type, "visual")];
  if (options?.brandId) conditions.push(eq(assetsTable.brandId, options.brandId));
  if (!options?.force) conditions.push(isNull(assetsTable.aiAnalyzedAt));

  let candidates = await db.select().from(assetsTable).where(and(...conditions));
  candidates = candidates.filter(isAnalyzableAsset);
  if (options?.limit && options.limit > 0) candidates = candidates.slice(0, options.limit);

  const result: BackfillAnalysisResult = {
    scanned: candidates.length,
    analyzed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const CONCURRENCY = 3;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (asset) => {
      try {
        await analyzeAndStoreAsset(asset.id);
        result.analyzed++;
      } catch (err) {
        result.failed++;
        result.errors.push({
          assetId: asset.id,
          name: asset.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }

  return result;
}

export function analyzeAssetInBackground(assetId: string): void {
  void analyzeAndStoreAsset(assetId)
    .then(() => console.log(`[asset-analysis] auto-analyzed asset ${assetId}`))
    .catch((err) =>
      console.warn(`[asset-analysis] auto-analysis failed for ${assetId}: ${err instanceof Error ? err.message : err}`),
    );
}

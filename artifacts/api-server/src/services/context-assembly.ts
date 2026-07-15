import { sanitizeLogoInstructions } from "./logo-intent.js";
import { db, brandsTable, templatesTable, assetsTable, hashtagSetsTable, styleProfilesTable, designerPersonasTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { GenerationPacket } from "./packet-assembly.js";
import type { StyleProfile, DesignerPersona } from "@workspace/db";

export interface SelectedAssetRef {
  assetId: string;
  role: "primary" | "supporting";
  order?: number;
}

export interface AssembledContext {
  brand: typeof brandsTable.$inferSelect;
  template: typeof templatesTable.$inferSelect;
  primaryAsset: typeof assetsTable.$inferSelect | null;
  supportingAssets: (typeof assetsTable.$inferSelect)[];
  combinedBrief: string;
  hashtagSets: (typeof hashtagSetsTable.$inferSelect)[];
  referenceAnalysis: Record<string, unknown> | null;
  generationPacket?: GenerationPacket | null;
  // Goal-aware posting: the creative's strategic intent (taxonomy key), used
  // to shape image tone/energy, caption structure/CTA, and headline framing.
  intent?: string | null;
  // The design style profile applied to this generation (or null). Injects its
  // style direction + color treatment into the image prompt.
  styleProfile?: StyleProfile | null;
  // Designer Persona ("Inspired by ...") applied to this generation (or null).
  // Account-scoped style inspiration; its fingerprint is injected into the
  // image prompt with look-and-feel PRECEDENCE over the style profile (brand
  // DNA — colors, coherence, imagenPrefix — still applies).
  designerPersona?: DesignerPersona | null;
  // Subject-vs-style reference balance for prompt emphasis (subject|balanced|style).
  referenceBalance?: string | null;
}

// Resolve the designer persona chosen for a creative. Personas are
// account-scoped, so there is no brand filter and no default fallback: no
// personaId means no persona.
export async function resolveDesignerPersona(
  personaId?: string | null,
): Promise<DesignerPersona | null> {
  if (!personaId) return null;
  const [persona] = await db.select().from(designerPersonasTable)
    .where(eq(designerPersonasTable.id, personaId));
  return persona || null;
}

// Resolve the style profile to use for a creative: the creative's explicitly
// chosen profile if set, otherwise the brand's default profile, otherwise null
// (existing behavior, no style applied).
export async function resolveStyleProfile(
  brandId: string,
  styleProfileId?: string | null,
): Promise<StyleProfile | null> {
  if (styleProfileId) {
    const [profile] = await db.select().from(styleProfilesTable)
      .where(and(eq(styleProfilesTable.id, styleProfileId), eq(styleProfilesTable.brandId, brandId)));
    if (profile) return profile;
  }
  const [fallback] = await db.select().from(styleProfilesTable)
    .where(and(eq(styleProfilesTable.brandId, brandId), eq(styleProfilesTable.isDefault, true)));
  return fallback || null;
}

export async function assembleContext(params: {
  brandId: string;
  templateId: string;
  selectedAssets: SelectedAssetRef[];
  selectedHashtagSetIds?: string[];
  briefText?: string;
  referenceAnalysis?: Record<string, unknown> | null;
  generationPacket?: GenerationPacket | null;
  intent?: string | null;
  styleProfile?: StyleProfile | null;
  designerPersona?: DesignerPersona | null;
  referenceBalance?: string | null;
}): Promise<AssembledContext> {
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, params.brandId));
  if (!brand) throw new Error(`Brand not found: ${params.brandId}`);

  const [template] = await db.select().from(templatesTable).where(eq(templatesTable.id, params.templateId));
  if (!template) throw new Error(`Template not found: ${params.templateId}`);

  let primaryAsset: typeof assetsTable.$inferSelect | null = null;
  let supportingAssets: (typeof assetsTable.$inferSelect)[] = [];

  if (params.generationPacket) {
    const packet = params.generationPacket;
    if (packet.generationAssets.length > 0) {
      primaryAsset = packet.generationAssets[0].asset;
      supportingAssets = packet.generationAssets.slice(1).map(a => a.asset);
    }
    for (const ctx of packet.contextAssets) {
      if (ctx.asset.type === "context" && ctx.asset.content) {
        supportingAssets.push(ctx.asset);
      }
    }
  } else {
    const primaryRef = params.selectedAssets.find(a => a.role === "primary");
    const supportingRefs = params.selectedAssets.filter(a => a.role === "supporting");

    if (primaryRef) {
      const [asset] = await db.select().from(assetsTable).where(eq(assetsTable.id, primaryRef.assetId));
      primaryAsset = asset || null;
    }

    if (supportingRefs.length > 0) {
      supportingAssets = await db.select().from(assetsTable)
        .where(inArray(assetsTable.id, supportingRefs.map(r => r.assetId)));
    }
  }

  const briefTexts: string[] = [];

  if (!params.generationPacket) {
    const contextAssets = params.selectedAssets.filter(a => a.role === "supporting");
    if (contextAssets.length > 0) {
      const contextItems = await db.select().from(assetsTable)
        .where(inArray(assetsTable.id, contextAssets.map(c => c.assetId)));
      for (const item of contextItems) {
        if (item.type === "context" && item.content) {
          briefTexts.push(item.content);
        }
      }
    }
  } else {
    for (const ctx of params.generationPacket.contextAssets) {
      if (ctx.asset.content) {
        briefTexts.push(ctx.asset.content);
      }
    }
  }

  if (params.briefText) {
    // Logo instructions never reach the prompt: logos are composited onto the
    // finished image (see logo-intent service), so the mention is stripped and
    // replaced with an explicit "no logos" guard.
    briefTexts.push(sanitizeLogoInstructions(params.briefText));
  }

  let hashtagSets: (typeof hashtagSetsTable.$inferSelect)[] = [];
  if (params.selectedHashtagSetIds && params.selectedHashtagSetIds.length > 0) {
    hashtagSets = await db.select().from(hashtagSetsTable)
      .where(inArray(hashtagSetsTable.id, params.selectedHashtagSetIds));
  } else {
    hashtagSets = await db.select().from(hashtagSetsTable)
      .where(eq(hashtagSetsTable.brandId, params.brandId));
  }

  if (hashtagSets.length > 0 && params.selectedHashtagSetIds && params.selectedHashtagSetIds.length > 0) {
    await db.update(hashtagSetsTable)
      .set({ usageCount: sql`COALESCE(${hashtagSetsTable.usageCount}, 0) + 1`, updatedAt: new Date() })
      .where(inArray(hashtagSetsTable.id, params.selectedHashtagSetIds));
  }

  return {
    brand,
    template,
    primaryAsset,
    supportingAssets,
    combinedBrief: briefTexts.join("\n\n"),
    hashtagSets,
    referenceAnalysis: params.referenceAnalysis || null,
    generationPacket: params.generationPacket || null,
    intent: params.intent || null,
    styleProfile: params.styleProfile || null,
    designerPersona: params.designerPersona || null,
    referenceBalance: params.referenceBalance || null,
  };
}

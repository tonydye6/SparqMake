/**
 * Creative direction for the Co-pilot Studio.
 *
 * This module closes the gap between the steering context the app stores
 * (brand DNA, style profiles, designer personas, taste guidance, intent) and
 * what the Co-pilot generation path actually sends to the image model:
 *
 *  - buildSessionStyleContract: deterministic, verbatim brand-constraint block.
 *    Prepended to every edit turn and appended (as non-negotiables) to every
 *    draft/compare prompt. No model call.
 *  - buildAssetCatalog: the brand's analyzed Asset Library as compact catalog
 *    lines, ranked against the brief with the same scoring the legacy
 *    /assets/match endpoint uses. Gives the director eyes on the library.
 *  - buildCreativeDirection: the "creative director" model step (replaces the
 *    old artDirectionPrompt). Receives the full deck and returns structured
 *    output: the image prompt, asset selections with roles, and aspect ratio.
 *    Falls back to prose-only behavior when the model output cannot be parsed.
 *  - mergeReferenceSlots: deterministic slot budgeting — manual attachments
 *    first, then director selections, guaranteed persona slots, packet fill.
 *
 * The legacy StudioNext pipeline (imagen.ts buildImagePrompt) is untouched;
 * block wording here is ported from it so both paths speak the same language.
 */

import { db, brandsTable, assetsTable } from "@workspace/db";
import type { Brand, StyleProfile, DesignerPersona, Asset } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { z } from "zod";
import { ai as geminiAi } from "@workspace/integrations-gemini-ai";
import { COPILOT_MODELS } from "../lib/ai-config.js";
import { INTENT_IMAGE_DIRECTIVES, isIntent } from "../lib/intents.js";
import { scoreAssetAgainstBrief, buildBriefTokenSet } from "./asset-matching.js";
import { extractJSON } from "../lib/extract-json.js";
import { logger } from "../lib/logger.js";
import type { ImageSlot } from "./interactions-client.js";

// ============================================================================
// Session style contract
// ============================================================================

/**
 * Deterministic brand-constraint text (~150-250 tokens for a fully configured
 * brand). Pure assembly from stored fields, skipping anything empty; safe to
 * call on every turn.
 */
export function buildSessionStyleContract(params: {
  brand: Brand;
  styleProfile?: StyleProfile | null;
  persona?: DesignerPersona | null;
}): string {
  const { brand, styleProfile, persona } = params;
  const parts: string[] = [];

  if (brand.characterStyleRules) {
    parts.push(`Character/style rules: ${brand.characterStyleRules}`);
  }

  const colorBits = [
    brand.colorPrimary && `primary ${brand.colorPrimary}`,
    brand.colorSecondary && `secondary ${brand.colorSecondary}`,
    brand.colorAccent && `accent ${brand.colorAccent}`,
    brand.colorBackground && `background ${brand.colorBackground}`,
  ].filter(Boolean);
  if (colorBits.length > 0) {
    parts.push(`Brand colors: ${colorBits.join(", ")}.`);
  }

  if (brand.negativePrompt) {
    parts.push(`Never include: ${brand.negativePrompt}`);
  }

  if (brand.imagenPrefix) {
    parts.push(`Brand visual language: ${brand.imagenPrefix}`);
  }

  if (styleProfile) {
    const bits: string[] = [];
    if (styleProfile.styleDirection) bits.push(styleProfile.styleDirection);
    if (styleProfile.colorTreatment) bits.push(`Color treatment: ${styleProfile.colorTreatment}`);
    if (bits.length > 0) {
      parts.push(`Design style "${styleProfile.name}": ${bits.join(" ")}`);
    }
  }

  if (persona) {
    const bits: string[] = [];
    if (persona.typography) bits.push(`typography: ${persona.typography}`);
    if (persona.composition) bits.push(`composition: ${persona.composition}`);
    if (persona.colorPhilosophy) bits.push(`color philosophy: ${persona.colorPhilosophy}`);
    if (persona.textureAndEffects) bits.push(`texture and effects: ${persona.textureAndEffects}`);
    if (persona.mood) bits.push(`mood: ${persona.mood}`);
    if (bits.length > 0) {
      parts.push(
        `Designer fingerprint ("${persona.name}") — the result must read as this designer's work: ${bits.join("; ")}`,
      );
    }
  }

  if (brand.tasteGuidance) {
    parts.push(`Team taste guidance (learned from past approvals/rejections): ${brand.tasteGuidance}`);
  }

  // Ported from imagen.ts buildImagePrompt brand-coherence block: production
  // runs showed wrong-brand marks on characters without this.
  if (brand.name) {
    parts.push(
      `Brand coherence: this image is for "${brand.name}". Every depicted character, uniform, jersey, signage, and prop must reflect ${brand.name}'s identity and colors only; never include names, wordmarks, or identity marks of any other brand or team.`,
    );
  }

  return parts.join("\n");
}

/**
 * Wrap an edit instruction with the style contract. The user's instruction is
 * explicitly primary: on conflict, the instruction wins.
 */
export function wrapEditInstruction(styleContract: string, instruction: string): string {
  if (!styleContract.trim()) return instruction;
  return (
    `STYLE CONTRACT (brand constraints to preserve unless the instruction below says otherwise):\n` +
    `${styleContract}\n\n` +
    `INSTRUCTION (the user's actual request — it always wins on conflict):\n` +
    `${instruction}`
  );
}

// ============================================================================
// Slot typing and merging
// ============================================================================

/**
 * Map an asset's stored upload-time classification to a model reference slot
 * type. Previously every attachment was hardcoded "object".
 */
export function slotTypeForAsset(asset: Pick<Asset, "assetClass" | "compositingOnly">): ImageSlot["slot"] {
  if (asset.compositingOnly || asset.assetClass === "compositing") return "object";
  if (asset.assetClass === "subject_reference") return "character";
  if (asset.assetClass === "style_reference") return "style";
  return "object";
}

/**
 * Reference description per slot type. Object/character references carry the
 * verbatim-fidelity note (the model must reproduce the real asset, e.g. the
 * actual brand logo); style references ask for treatment matching instead.
 */
export function slotDescriptionForAsset(
  asset: Pick<Asset, "name" | "description" | "characterIdentityNote">,
  slotType: ImageSlot["slot"],
): string {
  const base = `Brand asset "${asset.name}"${asset.description ? ` — ${asset.description}` : ""}`;
  if (slotType === "style") {
    return `${base}. Match this asset's visual style, treatment, and mood.`;
  }
  const identity = asset.characterIdentityNote ? ` ${asset.characterIdentityNote}` : "";
  return `${base}.${identity} Reproduce this exact asset faithfully as shown — do not redesign, restyle, or invent a different version of it.`;
}

/** Guaranteed persona work-sample slots when a persona is selected. */
export const PERSONA_GUARANTEED_SLOTS = 2;

/**
 * Deterministic slot budgeting under a hard cap.
 * Priority: manual attachments > director selections > guaranteed persona
 * slots > packet fill > leftovers (remaining persona, then packet, then
 * director overflow). Duplicate assetIds are dropped (first occurrence wins).
 */
export function mergeReferenceSlots(params: {
  attached: ImageSlot[];
  director?: ImageSlot[];
  packet: ImageSlot[];
  persona: ImageSlot[];
  cap: number;
}): ImageSlot[] {
  const { attached, director = [], packet, persona, cap } = params;
  const out: ImageSlot[] = [];
  const seen = new Set<string>();

  const push = (slot: ImageSlot): boolean => {
    if (out.length >= cap) return false;
    if (slot.assetId) {
      if (seen.has(slot.assetId)) return true;
      seen.add(slot.assetId);
    }
    out.push(slot);
    return true;
  };

  for (const s of attached) if (!push(s)) return out;

  const personaGuaranteed = persona.slice(0, PERSONA_GUARANTEED_SLOTS);
  const personaRest = persona.slice(PERSONA_GUARANTEED_SLOTS);

  // Reserve room for the guaranteed persona slots before director/packet fill,
  // but only when there is capacity for both director and persona after
  // attachments. If attachments already fill cap − personaGuaranteed.length or
  // more, director selections win and persona is dropped (persona overflow is
  // always lowest priority — the test "never exceeds the cap and drops persona
  // overflow last" encodes this contract explicitly).
  const reserve = Math.min(
    personaGuaranteed.length,
    Math.max(0, cap - out.length - director.length),
  );
  for (const s of director) {
    if (out.length >= cap - reserve) break;
    push(s);
  }
  for (const s of packet) {
    if (out.length >= cap - reserve) break;
    push(s);
  }
  for (const s of personaGuaranteed) if (!push(s)) return out;
  for (const s of [...personaRest, ...packet, ...director]) {
    if (out.length >= cap) break;
    push(s);
  }
  return out;
}

// ============================================================================
// Asset catalog (the director's view of the library)
// ============================================================================

export interface AssetCatalog {
  lines: string[];
  byId: Map<string, Asset>;
}

const CATALOG_MAX_LINES = 40;

function catalogLine(asset: Asset, kindLabel: string): string {
  const bits = [
    asset.id,
    asset.name,
    kindLabel,
    (asset.depictedEntities || []).join("/") || "-",
    (asset.tags || []).join("/") || "-",
    (asset.colors || []).join("/") || "-",
    asset.characterIdentityNote || asset.description || "-",
  ];
  return bits.join(" | ");
}

function catalogKindLabel(asset: Asset): string {
  if (asset.compositingOnly || asset.assetClass === "compositing") return "logo/brand mark";
  if (asset.assetClass === "subject_reference") return "subject";
  if (asset.assetClass === "style_reference") return "style";
  return asset.assetClass || "other";
}

/**
 * Rank the brand's image assets against the brief (same scoring as the legacy
 * /assets/match endpoint) and render them as compact catalog lines for the
 * director. Compositing-class assets (logos) are always included: the old
 * structural exclusion is lifted for the Co-pilot path so the director can
 * select the real brand marks.
 */
export async function buildAssetCatalog(params: {
  brandId: string;
  briefText: string;
  maxLines?: number;
}): Promise<AssetCatalog> {
  const { brandId, briefText } = params;
  const maxLines = params.maxLines ?? CATALOG_MAX_LINES;

  const assets = await db.select().from(assetsTable).where(and(
    eq(assetsTable.brandId, brandId),
    ne(assetsTable.status, "archived"),
  ));

  const briefTokens = buildBriefTokenSet(briefText);

  const eligible = assets.filter(a =>
    a.type === "visual" &&
    a.generationAllowed !== false &&
    Boolean(a.fileUrl) &&
    !(a.mimeType || "").includes("video"),
  );
  const compositing = assets.filter(a =>
    (a.compositingOnly || a.assetClass === "compositing") &&
    Boolean(a.fileUrl) &&
    !(a.mimeType || "").includes("video"),
  );

  const scored = eligible
    .filter(a => !compositing.includes(a))
    .map(a => ({ asset: a, ...scoreAssetAgainstBrief(a, briefTokens) }))
    .sort((x, y) => y.score - x.score);

  const byId = new Map<string, Asset>();
  const lines: string[] = [];

  // Logos/brand marks first — small in number and almost always relevant.
  for (const a of compositing) {
    if (lines.length >= maxLines) break;
    byId.set(a.id, a);
    lines.push(catalogLine(a, catalogKindLabel(a)));
  }
  for (const { asset } of scored) {
    if (lines.length >= maxLines) break;
    if (byId.has(asset.id)) continue;
    byId.set(asset.id, asset);
    lines.push(catalogLine(asset, catalogKindLabel(asset)));
  }

  return { lines, byId };
}

/**
 * Overflow text descriptors for selected assets that did not fit the image
 * slot budget — ported from the batch path (imagen.ts tiered injection) so
 * an asset past the cap still guides the scene instead of vanishing.
 */
export function buildOverflowDescriptors(assets: Asset[]): string {
  const withText = assets.filter(a =>
    a.description || a.styleNotes || (a.depictedEntities || []).length > 0,
  );
  if (withText.length === 0) return "";
  const lines = withText.map(a => {
    const bits: string[] = [];
    if (a.description) bits.push(a.description);
    if ((a.depictedEntities || []).length > 0) bits.push(`Depicts: ${(a.depictedEntities || []).join(", ")}`);
    if (a.styleNotes) bits.push(`Style: ${a.styleNotes}`);
    if ((a.colors || []).length > 0) bits.push(`Colors: ${(a.colors || []).join(", ")}`);
    return `- ${a.name}: ${bits.join(" ")}`;
  });
  return `\n\nADDITIONAL BRAND ASSET DESCRIPTORS (not attached as images; incorporate their subjects and look):\n${lines.join("\n")}`;
}

// ============================================================================
// The creative director model step
// ============================================================================

export interface DirectorAssetSelection {
  assetId: string;
  role: "subject" | "style" | "object";
}

export interface CreativeDirection {
  prompt: string;
  assetSelections: DirectorAssetSelection[];
  aspectRatio: "1:1" | "4:5" | "9:16" | "16:9";
  /** True when structured parsing failed and we fell back to prose-only. */
  usedFallback: boolean;
}

const directorOutputSchema = z.object({
  prompt: z.string().min(20),
  assetSelections: z.array(z.object({
    assetId: z.string().min(1),
    role: z.enum(["subject", "style", "object"]),
  })).max(12).default([]),
  aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).default("1:1"),
});

/**
 * Parse the director model's raw text into a CreativeDirection. Selections
 * whose assetId is not in the catalog are dropped (the model may not invent
 * asset ids). On any parse/validation failure the whole raw text becomes the
 * prompt — a rambling director never fails the turn.
 */
export function parseDirectorOutput(
  rawText: string,
  validAssetIds: Set<string>,
): CreativeDirection {
  const fallback: CreativeDirection = {
    prompt: rawText.trim(),
    assetSelections: [],
    aspectRatio: "1:1",
    usedFallback: true,
  };
  if (!rawText.trim()) return fallback;
  try {
    const parsed = directorOutputSchema.parse(extractJSON<unknown>(rawText));
    return {
      prompt: parsed.prompt.trim(),
      assetSelections: parsed.assetSelections.filter(s => validAssetIds.has(s.assetId)),
      aspectRatio: parsed.aspectRatio,
      usedFallback: false,
    };
  } catch {
    return fallback;
  }
}

/**
 * Gemini structured-output schema mirroring directorOutputSchema. Passing
 * responseSchema makes the API constrain decoding to this shape instead of
 * merely hinting via responseMimeType, which gemini-3.5-flash was observed
 * ignoring in live runs (short non-JSON text → prose fallback → no
 * selections).
 */
const DIRECTOR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    assetSelections: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          role: { type: "string", enum: ["subject", "style", "object"] },
        },
        required: ["assetId", "role"],
      },
    },
    aspectRatio: { type: "string", enum: ["1:1", "4:5", "9:16", "16:9"] },
  },
  required: ["prompt", "assetSelections", "aspectRatio"],
} as const;

const DIRECTOR_SYSTEM = `You are the creative director for an AI social-content studio. Given a brief, the brand's constraints, and a catalog of the brand's real asset library, produce visual direction for one social image.

Respond with ONLY a single JSON object — no preamble, no commentary, no markdown fences, nothing before or after the JSON:
{
  "prompt": "4-7 sentences of concrete visual direction: composition, subject framing, lighting, mood, color treatment. Name the selected assets and how each anchors the image. Do not describe caption text; headlines are overlaid separately.",
  "assetSelections": [{ "assetId": "<id from the catalog>", "role": "subject" | "style" | "object" }],
  "aspectRatio": "1:1" | "4:5" | "9:16" | "16:9"
}

Selection rules:
- Select ONLY asset ids that appear in the catalog. Up to 6 selections; fewer is fine; none is valid when nothing fits.
- role "subject": people, characters, mascots, products that must stay recognizable.
- role "object": logos and brand marks that must be reproduced exactly.
- role "style": images whose treatment and mood the result should match.
- Prefer assets whose entities/tags match the brief. Include the brand's logo (role "object") when the brief or brand rules imply branding should appear.
- aspectRatio: 1:1 unless the brief names a platform or format that clearly wants otherwise.`;

/**
 * The full-deck creative director call. Replaces the old artDirectionPrompt,
 * which received only 4 context fields and could not see the asset library.
 */
export async function buildCreativeDirection(params: {
  brand: Brand;
  styleContract: string;
  briefText: string;
  intent?: string | null;
  catalog: AssetCatalog;
}): Promise<CreativeDirection> {
  const { brand, styleContract, briefText, intent, catalog } = params;

  const intentBlock = intent && isIntent(intent) ? INTENT_IMAGE_DIRECTIVES[intent] : null;

  const context = [
    `Brief: ${briefText}`,
    intentBlock,
    `BRAND CONSTRAINTS (non-negotiable; your direction must fit inside them):\n${styleContract}`,
    catalog.lines.length > 0
      ? `ASSET CATALOG (id | name | kind | entities | tags | colors | note):\n${catalog.lines.join("\n")}`
      : `ASSET CATALOG: empty — this brand has no analyzed library assets yet; select nothing.`,
  ].filter(Boolean).join("\n\n");

  const callDirector = async (temperature: number): Promise<string> => {
    const response = await geminiAi.models.generateContent({
      model: COPILOT_MODELS.ART_DIRECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: context }] }],
      config: {
        systemInstruction: DIRECTOR_SYSTEM,
        // gemini-3.5-flash is a thinking model: its reasoning tokens count
        // against maxOutputTokens. With a 40-line catalog the old 1024 budget
        // was consumed by thoughts, truncating the JSON mid-object (the real
        // root cause of the live "110 chars of non-JSON" fallbacks).
        maxOutputTokens: 8192,
        temperature,
        responseMimeType: "application/json",
        responseSchema: DIRECTOR_RESPONSE_SCHEMA,
      },
    });
    return response.text ?? "";
  };

  const validIds = new Set(catalog.byId.keys());

  let text = await callDirector(0.7);
  let direction = text ? parseDirectorOutput(text, validIds) : null;

  // Retry once at temperature 0 when the first attempt produced no text or
  // unparseable output. Live runs showed gemini-3.5-flash occasionally
  // emitting short non-JSON text despite responseMimeType; a deterministic
  // retry recovers structured selections instead of silently degrading.
  if (!direction || direction.usedFallback) {
    logger.warn(
      { brandId: brand.id, chars: text.length },
      "Creative director output was not valid JSON — retrying once at temperature 0",
    );
    const retryText = await callDirector(0);
    if (retryText) {
      const retryDirection = parseDirectorOutput(retryText, validIds);
      if (!retryDirection.usedFallback) {
        return retryDirection;
      }
      // Prefer whichever attempt produced usable prose for the fallback.
      if (!direction || !direction.prompt) {
        text = retryText;
        direction = retryDirection;
      }
    }
  }

  if (!direction) throw new Error("No creative direction from model");

  if (direction.usedFallback) {
    logger.warn(
      { brandId: brand.id, chars: text.length },
      "Creative director output was not valid JSON after retry — falling back to prose-only direction",
    );
  }
  return direction;
}

/** Convenience: load a brand row or throw. */
export async function loadBrand(brandId: string): Promise<Brand> {
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) throw new Error("Brand not found");
  return brand;
}

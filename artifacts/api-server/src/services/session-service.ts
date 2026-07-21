/**
 * Co-pilot Studio session service.
 *
 * Orchestrates session lifecycle, turn execution, and cost tracking.
 * Every turn output is snapshotted as a creative_variants row exactly like
 * the existing studio — all downstream systems (storage, fan-out, publishing,
 * calendar, metrics, taste) keep working untouched.
 */

import { db, studioSessionsTable, sessionTurnsTable, creativesTable, creativeVariantsTable, costLogsTable, brandsTable, assetsTable, styleProfilesTable, designerPersonasTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { runImageInteraction, type ImageSlot } from "./interactions-client.js";
import { generateCaptions } from "./claude.js";
import { assembleContext, resolveStyleProfile, resolveDesignerPersona } from "./context-assembly.js";
import { compositeImage } from "./compositing.js";
import { writeBuffer, resolveUrl, readBuffer, contentTypeFor } from "./storage.js";
import { buildGenerationPacket, normalizeBalance, MAX_IMAGE_REFERENCES, type ReferenceBalance } from "./packet-assembly.js";
import { recordTasteSignal } from "./taste-signals.js";
import { COPILOT_MODELS, COST_ESTIMATES, estimateImagenCost, estimateClaudeCost, estimateGeminiTextCost } from "../lib/ai-config.js";
import { logger } from "../lib/logger.js";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { ai as geminiAi } from "@workspace/integrations-gemini-ai";
import { PLATFORM_CONFIGS } from "./imagen.js";
import { extractJSON } from "../lib/extract-json.js";
import type { CaptionResult } from "./claude.js";
import type { StudioSession, SessionTurn } from "@workspace/db";

export type { StudioSession, SessionTurn };

export type TurnAction =
  | "draft"
  | "edit_image"
  | "caption"
  | "compare";

export interface TurnInput {
  action: TurnAction;
  instruction: string;
  platform?: string;
  compareCount?: number;
}

export interface TurnProgressEvent {
  type: "status" | "progress" | "result" | "error";
  message: string;
  step?: string;
  done?: boolean;
  data?: Record<string, unknown>;
}

type ProgressCallback = (event: TurnProgressEvent) => void;

const MAX_PERSONA_REFERENCE_IMAGES = 3;

async function loadPersonaSlots(personaId: string | null): Promise<ImageSlot[]> {
  if (!personaId) return [];
  const [persona] = await db.select().from(designerPersonasTable).where(eq(designerPersonasTable.id, personaId));
  if (!persona) return [];
  const refs = (persona.referenceImages || []) as Array<{ url?: string; label?: string }>;
  const slots: ImageSlot[] = [];
  for (const ref of refs.slice(0, MAX_PERSONA_REFERENCE_IMAGES)) {
    if (!ref.url) continue;
    const loc = resolveUrl(ref.url);
    if (!loc) continue;
    const buf = await readBuffer(loc);
    if (!buf) continue;
    slots.push({
      imageBuffer: buf,
      mimeType: contentTypeFor(loc.filename),
      slot: "style",
      description: `Work sample by designer persona${ref.label ? ` (${ref.label})` : ""}`,
    });
  }
  return slots;
}

async function loadPacketSlots(packet: Awaited<ReturnType<typeof buildGenerationPacket>>): Promise<ImageSlot[]> {
  const slots: ImageSlot[] = [];
  for (const entry of packet.generationAssets.slice(0, MAX_IMAGE_REFERENCES)) {
    if (!entry.asset.fileUrl) continue;
    const loc = resolveUrl(entry.asset.fileUrl);
    if (!loc) continue;
    const buf = await readBuffer(loc);
    if (!buf) continue;
    slots.push({
      imageBuffer: buf,
      mimeType: entry.asset.mimeType || "image/png",
      slot: entry.role === "style_reference" ? "style" : "character",
      description: entry.asset.characterIdentityNote || entry.asset.description || entry.asset.name,
    });
  }
  return slots;
}

async function artDirectionPrompt(params: {
  brandId: string;
  briefText: string;
  intent?: string | null;
}): Promise<string> {
  const { brandId, briefText, intent } = params;
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) throw new Error("Brand not found");

  const systemInstruction = `You are a world-class art director creating precise visual direction for an AI image generator. Be specific, evocative, and brief (3-5 sentences). Focus on: composition, lighting, mood, color treatment, subject framing. Do not describe text or captions — those are overlaid separately.`;

  const context = [
    brand.imagenPrefix && `Brand visual prefix: ${brand.imagenPrefix}`,
    brand.characterStyleRules && `Character/style rules: ${brand.characterStyleRules}`,
    brand.tasteGuidance && `Team taste guidance: ${brand.tasteGuidance}`,
    intent && `Post intent: ${intent}`,
    `Brief: ${briefText}`,
  ].filter(Boolean).join("\n");

  // ART_DIRECTION_MODEL is a Gemini text model — use generateContent, NOT anthropic.
  const response = await geminiAi.models.generateContent({
    model: COPILOT_MODELS.ART_DIRECTION_MODEL,
    contents: [{ role: "user", parts: [{ text: context }] }],
    config: { systemInstruction, maxOutputTokens: 512, temperature: 0.7 },
  });

  const text = response.text;
  if (!text) throw new Error("No art direction from model");
  return text.trim();
}

async function buildImageAwareCaption(params: {
  brandId: string;
  briefText: string;
  imageBuffer: Buffer;
  imageMimeType: string;
  platform?: string;
  existingCaptions?: Partial<CaptionResult>;
  intent?: string | null;
  twoAlternates?: boolean;
}): Promise<{ captions: CaptionResult; alternates?: { caption: string; headline: string }[] }> {
  const { brandId, briefText, imageBuffer, imageMimeType, platform, existingCaptions, intent, twoAlternates } = params;
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) throw new Error("Brand not found");

  const voiceExamples = (brand as typeof brand & { voiceExamples?: string[] | null }).voiceExamples;
  const bannedTerms = brand.bannedTerms || [];
  const platformRules = brand.platformRules as Record<string, { char_limit?: number }> | null;

  const fewShotSection = voiceExamples && voiceExamples.length > 0
    ? `\nBRAND VOICE EXAMPLES (few-shot; match this tone and energy):\n${voiceExamples.map((ex, i) => `${i + 1}. "${ex}"`).join("\n")}\n`
    : "";

  const platformList = platform ? [platform] : ["instagram_feed", "instagram_story", "twitter", "linkedin", "tiktok"];
  const platformLimits = platformList.map(p => {
    const limit = (platformRules?.[p] as { char_limit?: number } | undefined)?.char_limit;
    return `- ${p}: ${limit || 2200} chars max`;
  }).join("\n");

  const system = `You are a social media copywriter for ${brand.name}.
VOICE: ${brand.voiceDescription}
${brand.trademarkRules ? `TRADEMARK RULES:\n${brand.trademarkRules}\n` : ""}${bannedTerms.length > 0 ? `NEVER USE: ${bannedTerms.join(", ")}\n` : ""}${fewShotSection}
PLATFORM CHARACTER LIMITS:\n${platformLimits}
IMPORTANT: Captions must be written AGAINST the actual image content — describe what is shown, not what was briefed. The image is attached.`;

  const intentLine = intent ? `Post intent: ${intent}\n` : "";
  const briefLine = briefText ? `Brief: ${briefText}\n` : "";

  const alternatesInstruction = twoAlternates && platform
    ? `\nReturn 2 alternate caption+headline pairs for "${platform}" using the same JSON shape as the main result, in an "alternates" array.`
    : "";

  const userMessage = `${intentLine}${briefLine}Look at the image and generate captions for: ${platformList.join(", ")}.

Return ONLY valid JSON:
{
  ${platformList.map(p => `"${p}": { "caption": "...", "headline": "..." }`).join(",\n  ")}${twoAlternates && platform ? `,\n  "alternates": [{ "caption": "...", "headline": "..." }, { "caption": "...", "headline": "..." }]` : ""}
}${alternatesInstruction}

Each headline: punchy, platform-appropriate, 3-8 words. No em dashes.`;

  const imageData = imageBuffer.toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    temperature: 0.7,
    system,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: (imageMimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp") || "image/png", data: imageData } },
        { type: "text", text: userMessage },
      ],
    }],
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No caption from model");

  const parsed = extractJSON<Record<string, unknown>>(textBlock.text);
  const defaults = { caption: "", headline: "" };

  const captions: CaptionResult = {
    instagram_feed: { ...defaults, ...(parsed.instagram_feed as object | undefined) },
    instagram_story: { ...defaults, ...(parsed.instagram_story as object | undefined) },
    twitter: { ...defaults, ...(parsed.twitter as object | undefined) },
    linkedin: { ...defaults, ...(parsed.linkedin as object | undefined) },
    tiktok: { ...defaults, ...(parsed.tiktok as object | undefined) },
  };

  const rawAlternates = parsed.alternates;
  const alternates = Array.isArray(rawAlternates)
    ? (rawAlternates as Array<{ caption?: string; headline?: string }>).map(a => ({
        caption: String(a.caption || ""),
        headline: String(a.headline || ""),
      }))
    : undefined;

  return { captions, alternates };
}

async function saveTurnVariants(params: {
  creativeId: string;
  sessionId: string;
  imageBuffer: Buffer;
  imageMimeType: string;
  captions: CaptionResult;
  sourceTurnId?: string;
  sourceVariantId?: string;
  label?: string;
}): Promise<string[]> {
  const { creativeId, imageBuffer, imageMimeType, captions, sourceVariantId, label } = params;
  const platforms = Object.keys(PLATFORM_CONFIGS);
  const variantIds: string[] = [];

  const imageFilename = `copilot-${crypto.randomUUID()}.png`;
  await writeBuffer("generated", imageFilename, imageBuffer);
  const rawImageUrl = `/api/files/generated/${imageFilename}`;

  for (const platform of platforms) {
    const captionKey = platform as keyof CaptionResult;
    const cap = captions[captionKey] || { caption: "", headline: "" };
    const [variant] = await db.insert(creativeVariantsTable).values({
      creativeId,
      platform,
      aspectRatio: PLATFORM_CONFIGS[platform]?.aspectRatio || "1:1",
      rawImageUrl,
      compositedImageUrl: rawImageUrl,
      caption: cap.caption,
      headlineText: cap.headline,
      status: "generated",
      sourceVariantId: sourceVariantId || null,
    }).returning({ id: creativeVariantsTable.id });
    if (variant) variantIds.push(variant.id);
  }

  return variantIds;
}

export interface SessionWithTurns {
  session: StudioSession;
  turns: (SessionTurn & { variantUrls?: string[] })[];
}

export async function getSessionWithTurns(sessionId: string): Promise<SessionWithTurns | null> {
  const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
  if (!session) return null;

  const turns = await db.select().from(sessionTurnsTable)
    .where(eq(sessionTurnsTable.sessionId, sessionId))
    .orderBy(sessionTurnsTable.seq);

  const enriched = await Promise.all(turns.map(async (turn) => {
    const variantIds = (turn.resultVariantIds || []) as string[];
    if (variantIds.length === 0) return turn;
    const variants = await db.select({
      id: creativeVariantsTable.id,
      platform: creativeVariantsTable.platform,
      compositedImageUrl: creativeVariantsTable.compositedImageUrl,
      rawImageUrl: creativeVariantsTable.rawImageUrl,
      caption: creativeVariantsTable.caption,
      headlineText: creativeVariantsTable.headlineText,
    }).from(creativeVariantsTable).where(
      eq(creativeVariantsTable.id, variantIds[0])
    );
    return { ...turn, variantUrls: variants.map(v => v.compositedImageUrl || v.rawImageUrl || "") };
  }));

  return { session, turns: enriched };
}

/**
 * Branch the session to a historical variant: sets activeVariantId and restores
 * the imageInteractionId from the turn that produced that variant, so subsequent
 * edit_image turns continue from that historical state rather than the latest one.
 */
export async function branchSession(params: {
  sessionId: string;
  variantId: string;
}): Promise<{ sessionId: string; activeVariantId: string; imageInteractionId: string | null }> {
  const { sessionId, variantId } = params;

  const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
  if (!session) throw new Error("Session not found");

  // Find the turn whose resultVariantIds contains this variantId
  const turns = await db.select().from(sessionTurnsTable)
    .where(and(eq(sessionTurnsTable.sessionId, sessionId), eq(sessionTurnsTable.role, "copilot")));

  const sourceTurn = turns.find(t =>
    t.role === "copilot" && ((t.resultVariantIds || []) as string[]).includes(variantId)
  );

  const restoredInteractionId = sourceTurn?.interactionId ?? null;

  await db.update(studioSessionsTable).set({
    activeVariantId: variantId,
    imageInteractionId: restoredInteractionId,
    updatedAt: new Date(),
  }).where(eq(studioSessionsTable.id, sessionId));

  return { sessionId, activeVariantId: variantId, imageInteractionId: restoredInteractionId };
}

export async function createSession(params: {
  brandId: string;
  briefText: string;
  createdBy: string;
  conceptId?: string;
  intent?: string;
  styleProfileId?: string;
  personaId?: string;
  selectedAssetIds?: string[];
}): Promise<StudioSession> {
  const { brandId, briefText, createdBy, conceptId, intent, styleProfileId, personaId } = params;

  const [creative] = await db.insert(creativesTable).values({
    brandId,
    name: briefText.slice(0, 80) || "Co-pilot session",
    status: "draft",
    briefText,
    intent: intent || null,
    styleProfileId: styleProfileId || null,
    personaId: personaId || null,
    selectedAssets: (params.selectedAssetIds || []).map(id => ({ assetId: id, role: "primary" })),
    createdBy,
    selectedConceptId: conceptId || null,
  }).returning();

  const [session] = await db.insert(studioSessionsTable).values({
    creativeId: creative.id,
    brandId,
    status: "drafting",
    createdBy,
    sessionTitle: briefText.slice(0, 80),
  }).returning();

  return session;
}

export async function executeTurn(params: {
  sessionId: string;
  input: TurnInput;
  userId: string;
  onProgress: ProgressCallback;
}): Promise<SessionTurn> {
  const { sessionId, input, userId, onProgress } = params;

  const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
  if (!session) throw new Error("Session not found");

  const [creative] = await db.select().from(creativesTable).where(eq(creativesTable.id, session.creativeId));
  if (!creative) throw new Error("Creative not found for session");

  const [lastTurn] = await db.select().from(sessionTurnsTable)
    .where(eq(sessionTurnsTable.sessionId, sessionId))
    .orderBy(desc(sessionTurnsTable.seq))
    .limit(1);

  const nextSeq = (lastTurn?.seq ?? 0) + 1;

  const [userTurn] = await db.insert(sessionTurnsTable).values({
    sessionId,
    seq: nextSeq,
    role: "user",
    instruction: input.instruction,
    action: input.action,
    status: "pending",
    instructionPayload: {
      platform: input.platform,
      compareCount: input.compareCount,
    },
  }).returning();

  const copilotSeq = nextSeq + 1;
  const [copilotTurn] = await db.insert(sessionTurnsTable).values({
    sessionId,
    seq: copilotSeq,
    role: "copilot",
    instruction: null,
    action: input.action,
    status: "running",
  }).returning();

  const startMs = Date.now();

  try {
    const result = await executeActionCore({
      session,
      creative,
      input,
      userId,
      onProgress,
    });

    const durationMs = Date.now() - startMs;
    const now = new Date();

    await db.update(sessionTurnsTable).set({
      status: "done",
      resultVariantIds: result.variantIds,
      interactionId: result.interactionId || null,
      costUsd: result.costUsd,
      durationMs,
      metadata: result.metadata || null,
      updatedAt: now,
    }).where(eq(sessionTurnsTable.id, copilotTurn.id));

    const activeVariantId = result.variantIds[0] || session.activeVariantId;
    const thumbnailUrl = result.thumbnailUrl || session.thumbnailUrl;

    await db.update(studioSessionsTable).set({
      imageInteractionId: result.interactionId || session.imageInteractionId,
      activeVariantId,
      thumbnailUrl,
      lastTurnSummary: result.summary,
      status: "refining",
      totalCostUsd: sql<number>`${studioSessionsTable.totalCostUsd} + ${result.costUsd || 0}`,
      updatedAt: now,
    }).where(eq(studioSessionsTable.id, sessionId));

    if (result.costUsd && result.costUsd > 0) {
      await db.insert(costLogsTable).values({
        creativeId: creative.id,
        service: "copilot",
        operation: input.action,
        model: result.modelUsed || COPILOT_MODELS.NANO_BANANA_MODEL,
        costUsd: result.costUsd,
      });
    }

    if (input.action === "edit_image" || input.action === "caption") {
      void recordTasteSignal({
        brandId: creative.brandId,
        creativeId: creative.id,
        variantId: activeVariantId || null,
        signalType: "edit_instruction",
        payload: { instruction: input.instruction, action: input.action, platform: input.platform },
        userId,
      });
    }

    const [refreshed] = await db.select().from(sessionTurnsTable).where(eq(sessionTurnsTable.id, copilotTurn.id));
    onProgress({
      type: "result",
      message: result.summary,
      data: {
        variantIds: result.variantIds,
        interactionId: result.interactionId,
        // Surface caption alternates so the SSE client can populate the alternates panel
        ...(result.metadata?.alternates ? { alternates: result.metadata.alternates } : {}),
      },
    });
    return refreshed;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sessionId, action: input.action }, "Turn execution failed");

    await db.update(sessionTurnsTable).set({
      status: "error",
      error: errMsg,
      updatedAt: new Date(),
    }).where(eq(sessionTurnsTable.id, copilotTurn.id));

    onProgress({ type: "error", message: errMsg });
    throw err;
  }
}

interface ActionResult {
  variantIds: string[];
  interactionId?: string;
  costUsd: number;
  summary: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
  modelUsed?: string;
}

async function executeActionCore(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  userId: string;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  switch (input.action) {
    case "draft": return executeDraft({ session, creative, input, onProgress });
    case "edit_image": return executeEditImage({ session, creative, input, onProgress });
    case "caption": return executeCaption({ session, creative, input, onProgress });
    case "compare": return executeCompare({ session, creative, input, onProgress });
    default:
      throw new Error(`Unknown action: ${(input as TurnInput).action}`);
  }
}

async function executeDraft(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  onProgress({ type: "progress", step: "art-direction", message: "Writing art direction..." });

  const artDirection = await artDirectionPrompt({
    brandId: creative.brandId,
    briefText: input.instruction || creative.briefText || "",
    intent: creative.intent,
  });

  onProgress({ type: "progress", step: "packet", message: "Building reference packet..." });

  const selectedAssets = (creative.selectedAssets || []) as Array<{ assetId: string; role: string }>;
  const selectedAssetIds = selectedAssets.map(a => a.assetId);
  const styleProfile = await resolveStyleProfile(creative.brandId, creative.styleProfileId);
  const styleRefIds = styleProfile?.referenceAssetIds || [];

  let packetSlots: ImageSlot[] = [];
  if (selectedAssetIds.length > 0 || styleRefIds.length > 0) {
    const packet = await buildGenerationPacket({
      creativeId: creative.id,
      brandId: creative.brandId,
      templateId: creative.templateId || "",
      platform: "all",
      selectedAssetIds,
      priorityStyleAssetIds: styleRefIds,
      briefText: input.instruction || creative.briefText,
      balance: normalizeBalance(creative.referenceBalance) as ReferenceBalance,
    });
    packetSlots = await loadPacketSlots(packet);
    onProgress({ type: "progress", step: "packet", message: `Packet: ${packetSlots.length} reference image(s)`, done: true });
  }

  const personaSlots = await loadPersonaSlots(creative.personaId);
  const allSlots = [...packetSlots, ...personaSlots].slice(0, MAX_IMAGE_REFERENCES);

  onProgress({ type: "progress", step: "image", message: `Generating image via ${COPILOT_MODELS.NANO_BANANA_MODEL}...` });

  const imageResult = await runImageInteraction({
    prompt: artDirection,
    slots: allSlots,
    previousInteractionId: null,
    aspectRatio: "1:1",
  });

  onProgress({ type: "progress", step: "image", message: "Image generated", done: true });
  onProgress({ type: "progress", step: "captions", message: "Generating image-aware captions..." });

  const { captions } = await buildImageAwareCaption({
    brandId: creative.brandId,
    briefText: input.instruction || creative.briefText || "",
    imageBuffer: imageResult.imageBuffer,
    imageMimeType: imageResult.mimeType,
    intent: creative.intent,
  });

  onProgress({ type: "progress", step: "captions", message: "Captions written against the image", done: true });
  onProgress({ type: "progress", step: "saving", message: "Saving turn output..." });

  const variantIds = await saveTurnVariants({
    creativeId: creative.id,
    sessionId: session.id,
    imageBuffer: imageResult.imageBuffer,
    imageMimeType: imageResult.mimeType,
    captions,
    sourceTurnId: undefined,
    label: "draft",
  });

  const thumbnailFilename = `thumb-${crypto.randomUUID()}.png`;
  await writeBuffer("generated", thumbnailFilename, imageResult.imageBuffer);
  const thumbnailUrl = `/api/files/generated/${thumbnailFilename}`;

  const refCount = allSlots.length;
  const costUsd = estimateImagenCost(1) + estimateClaudeCost() + estimateGeminiTextCost();

  return {
    variantIds,
    interactionId: imageResult.interactionId,
    costUsd,
    summary: `Draft created: ${refCount} brand ref${refCount !== 1 ? "s" : ""} used, captions written against image`,
    thumbnailUrl,
    metadata: { artDirection, refCount },
    modelUsed: COPILOT_MODELS.NANO_BANANA_MODEL,
  };
}

async function executeEditImage(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  if (!session.imageInteractionId) {
    throw new Error("No previous image interaction to edit. Start a draft turn first.");
  }

  onProgress({ type: "progress", step: "image", message: `Editing image (targeted preserving edit, not a re-roll)...` });

  const imageResult = await runImageInteraction({
    prompt: input.instruction,
    slots: [],
    previousInteractionId: session.imageInteractionId,
    aspectRatio: "1:1",
  });

  onProgress({ type: "progress", step: "image", message: "Edit applied", done: true });
  onProgress({ type: "progress", step: "captions", message: "Rewriting captions against edited image..." });

  const { captions } = await buildImageAwareCaption({
    brandId: creative.brandId,
    briefText: creative.briefText || "",
    imageBuffer: imageResult.imageBuffer,
    imageMimeType: imageResult.mimeType,
    intent: creative.intent,
  });

  onProgress({ type: "progress", step: "captions", message: "Captions updated", done: true });

  const activeVariantId = session.activeVariantId;
  const variantIds = await saveTurnVariants({
    creativeId: creative.id,
    sessionId: session.id,
    imageBuffer: imageResult.imageBuffer,
    imageMimeType: imageResult.mimeType,
    captions,
    sourceVariantId: activeVariantId || undefined,
    label: "edit",
  });

  const costUsd = estimateImagenCost(1) + estimateClaudeCost();

  return {
    variantIds,
    interactionId: imageResult.interactionId,
    costUsd,
    summary: `Targeted edit: not a re-roll, composition preserved`,
    metadata: { instruction: input.instruction },
    modelUsed: COPILOT_MODELS.NANO_BANANA_MODEL,
  };
}

async function executeCaption(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  const activeVariantId = session.activeVariantId;
  if (!activeVariantId) {
    throw new Error("No active variant to write captions against. Run a draft or edit first.");
  }

  onProgress({ type: "progress", step: "captions", message: "Loading current image..." });

  const [variant] = await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, activeVariantId));
  if (!variant) throw new Error("Active variant not found");

  const imageUrl = variant.compositedImageUrl || variant.rawImageUrl;
  if (!imageUrl) throw new Error("Active variant has no image");

  const loc = resolveUrl(imageUrl);
  if (!loc) throw new Error("Cannot resolve image URL");
  const imageBuffer = await readBuffer(loc);
  if (!imageBuffer) throw new Error("Could not read image buffer");

  onProgress({ type: "progress", step: "captions", message: "Writing captions against current image..." });

  const { captions: newCaptions, alternates } = await buildImageAwareCaption({
    brandId: creative.brandId,
    briefText: `${input.instruction}. ${creative.briefText || ""}`.trim(),
    imageBuffer,
    imageMimeType: variant.rawImageUrl ? contentTypeFor(loc.filename) : "image/png",
    platform: input.platform,
    intent: creative.intent,
    twoAlternates: true,
  });

  // When the request targets a single platform, preserve all other platform captions
  // from the sibling variants of the current active set (same rawImageUrl group).
  // Without this, saveTurnVariants would write empty-string captions for non-target platforms.
  let captions = newCaptions;
  if (input.platform && variant.rawImageUrl) {
    const siblings = await db.select({
      platform: creativeVariantsTable.platform,
      caption: creativeVariantsTable.caption,
      headlineText: creativeVariantsTable.headlineText,
    }).from(creativeVariantsTable).where(
      and(
        eq(creativeVariantsTable.creativeId, creative.id),
        eq(creativeVariantsTable.rawImageUrl, variant.rawImageUrl),
      )
    );

    const existing: Partial<CaptionResult> = {};
    for (const s of siblings) {
      const p = s.platform as keyof CaptionResult;
      if (p) existing[p] = { caption: s.caption || "", headline: s.headlineText || "" };
    }

    // Merge: start from existing captions, then apply the newly generated platform on top
    const defaults = { caption: "", headline: "" };
    captions = {
      instagram_feed: existing.instagram_feed || defaults,
      instagram_story: existing.instagram_story || defaults,
      twitter: existing.twitter || defaults,
      linkedin: existing.linkedin || defaults,
      tiktok: existing.tiktok || defaults,
    };
    const targetPlatform = input.platform as keyof CaptionResult;
    const generatedForTarget = newCaptions[targetPlatform];
    if (generatedForTarget) captions[targetPlatform] = generatedForTarget;
  }

  onProgress({ type: "progress", step: "captions", message: "Captions written, 2 alternates generated", done: true });
  onProgress({ type: "progress", step: "saving", message: "Saving updated caption variants..." });

  const variantIds = await saveTurnVariants({
    creativeId: creative.id,
    sessionId: session.id,
    imageBuffer,
    imageMimeType: variant.rawImageUrl ? contentTypeFor(loc.filename) : "image/png",
    captions,
    sourceVariantId: activeVariantId,
    label: "caption",
  });

  const platLabel = input.platform ? ` for ${input.platform}` : " for all platforms";
  const costUsd = estimateClaudeCost();

  return {
    variantIds,
    costUsd,
    summary: `Caption rewrite${platLabel}: 2 alternates available`,
    metadata: {
      platform: input.platform,
      alternates,
    },
    modelUsed: "claude-sonnet-4-6",
  };
}

async function executeCompare(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  const count = input.compareCount || 3;
  onProgress({ type: "progress", step: "compare", message: `Generating ${count} takes for comparison...` });

  const selectedAssets = (creative.selectedAssets || []) as Array<{ assetId: string; role: string }>;
  const selectedAssetIds = selectedAssets.map(a => a.assetId);
  const styleProfile = await resolveStyleProfile(creative.brandId, creative.styleProfileId);
  const styleRefIds = styleProfile?.referenceAssetIds || [];

  let packetSlots: ImageSlot[] = [];
  if (selectedAssetIds.length > 0 || styleRefIds.length > 0) {
    const packet = await buildGenerationPacket({
      creativeId: creative.id,
      brandId: creative.brandId,
      templateId: creative.templateId || "",
      platform: "all",
      selectedAssetIds,
      priorityStyleAssetIds: styleRefIds,
      briefText: input.instruction || creative.briefText,
      balance: normalizeBalance(creative.referenceBalance) as ReferenceBalance,
    });
    packetSlots = await loadPacketSlots(packet);
  }

  const personaSlots = await loadPersonaSlots(creative.personaId);
  const allSlots = [...packetSlots, ...personaSlots].slice(0, MAX_IMAGE_REFERENCES);

  const artDirection = await artDirectionPrompt({
    brandId: creative.brandId,
    briefText: input.instruction || creative.briefText || "",
    intent: creative.intent,
  });

  // One canonical (first-platform) variant ID per take — UI renders these as the N take thumbnails.
  // All per-platform variants for the take are stored in creative_variants for downstream use but
  // only the canonical representative is returned in the turn's resultVariantIds for the pick UI.
  const canonicalTakeIds: string[] = [];
  // Full per-take breakdown stored in metadata for downstream use.
  const perTakeVariantIds: string[][] = [];
  // Per-take interaction IDs — restored when user picks a compare take so
  // subsequent edit_image turns continue from the chosen take's edit chain.
  const perTakeInteractionIds: string[] = [];
  let totalCost = 0;

  for (let i = 0; i < count; i++) {
    onProgress({ type: "progress", step: "compare", message: `Generating take ${i + 1} of ${count}...` });
    const result = await runImageInteraction({
      prompt: `${artDirection}\n\nVARIATION ${i + 1}: Fresh composition, same brief.`,
      slots: allSlots,
      previousInteractionId: null,
      aspectRatio: "1:1",
    });

    const { captions } = await buildImageAwareCaption({
      brandId: creative.brandId,
      briefText: input.instruction || creative.briefText || "",
      imageBuffer: result.imageBuffer,
      imageMimeType: result.mimeType,
      intent: creative.intent,
    });

    const variantIds = await saveTurnVariants({
      creativeId: creative.id,
      sessionId: session.id,
      imageBuffer: result.imageBuffer,
      imageMimeType: result.mimeType,
      captions,
      sourceVariantId: session.activeVariantId || undefined,
      label: `compare-${i + 1}`,
    });

    // variantIds[0] is the first platform (instagram_feed) — canonical representative
    if (variantIds[0]) canonicalTakeIds.push(variantIds[0]);
    perTakeVariantIds.push(variantIds);
    perTakeInteractionIds.push(result.interactionId);
    totalCost += estimateImagenCost(1) + estimateClaudeCost();
  }

  return {
    // resultVariantIds contains one canonical ID per take for the pick UI
    variantIds: canonicalTakeIds,
    // session imageInteractionId stays at the first take for preview;
    // the pick endpoint will restore the chosen take's interactionId
    interactionId: perTakeInteractionIds[0],
    costUsd: totalCost,
    summary: `${count} takes generated side-by-side for comparison`,
    metadata: { count, perTakeVariantIds, perTakeInteractionIds },
    modelUsed: COPILOT_MODELS.NANO_BANANA_MODEL,
  };
}

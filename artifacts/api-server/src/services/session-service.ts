/**
 * Co-pilot Studio session service.
 *
 * Orchestrates session lifecycle, turn execution, and cost tracking.
 * Every turn output is snapshotted as a creative_variants row exactly like
 * the existing studio — all downstream systems (storage, fan-out, publishing,
 * calendar, metrics, taste) keep working untouched.
 */

import { db, studioSessionsTable, sessionTurnsTable, creativesTable, creativeVariantsTable, costLogsTable, brandsTable, assetsTable, styleProfilesTable, designerPersonasTable, calendarEntriesTable, socialAccountsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { runImageInteraction, runVideoInteraction, type ImageSlot } from "./interactions-client.js";
import { generateCaptions } from "./claude.js";
import { assembleContext, resolveStyleProfile, resolveDesignerPersona } from "./context-assembly.js";
import { compositeImage, reframeImage, imageDimensions } from "./compositing.js";
import { detectSubject, predictClip } from "./focal-point.js";
import { outpaintImage } from "./imagen.js";
import { getIntentInsights } from "./performance-insights.js";
import { writeBuffer, resolveUrl, readBuffer, contentTypeFor } from "./storage.js";
import { buildGenerationPacket, normalizeBalance, MAX_IMAGE_REFERENCES, type ReferenceBalance } from "./packet-assembly.js";
import { recordTasteSignal } from "./taste-signals.js";
import { AI_MODELS, COPILOT_MODELS, COST_ESTIMATES, estimateImagenCost, estimateClaudeCost, estimateGeminiTextCost, estimateVideoDurationSeconds } from "../lib/ai-config.js";
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
  | "edit_region"
  | "caption"
  | "compare"
  | "convert_video"
  | "edit_video"
  | "fan_out"
  | "schedule";

export interface TurnInput {
  action: TurnAction;
  instruction: string;
  platform?: string;
  compareCount?: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  schedules?: Array<{ variantId: string; platform: string; scheduledAt: string }>;
  // Optional: target a specific variant for convert_video (e.g. a fan-out YouTube card)
  // instead of the session's current activeVariantId.
  sourceVariantId?: string;
  // Asset Library attachments for edit turns: the referenced assets' real image
  // files are passed to the model as reference content blocks so it reproduces
  // the actual asset (e.g. the real brand logo) instead of hallucinating one.
  assetIds?: string[];
  // D1: AbortSignal threaded from the HTTP route so client disconnect / SSE timeout
  // propagates into model calls, preventing zombie turns that keep billing.
  signal?: AbortSignal;
}

export interface FanOutPlatformCard {
  platform: string;
  variantId: string;
  imageUrl: string;
  caption: string;
  headline: string;
  suggestedAt: string;
  // true for video platforms (YouTube) — the thumbnail reframe is stored but
  // scheduling requires a video variant from convert_video first.
  requiresVideo?: boolean;
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

  // Derive platform list from the single source of truth — adding new platforms
  // to PLATFORM_CONFIGS automatically includes them here without touching this function.
  const platformList = platform ? [platform] : Object.keys(PLATFORM_CONFIGS);
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
  // Stored mime types can lie (e.g. a .png filename holding JPEG bytes from the
  // image model) and Anthropic rejects mismatches — sniff the real format.
  const sniffedMime = sniffImageMime(imageBuffer) || imageMimeType || "image/png";

  const tasteGuidanceSection = brand.tasteGuidance
    ? `\nTEAM TASTE GUIDANCE (learned from past approvals/rejections):\n${brand.tasteGuidance}\n`
    : "";

  const fullSystem = system.replace(
    "IMPORTANT: Captions must be written AGAINST",
    `${tasteGuidanceSection}IMPORTANT: Captions must be written AGAINST`,
  );

  const response = await anthropic.messages.create({
    model: AI_MODELS.CLAUDE_SONNET,
    max_tokens: 2048,
    temperature: 0.7,
    system: fullSystem,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: sniffedMime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: imageData } },
        { type: "text", text: userMessage },
      ],
    }],
  });

  const textBlock = response.content.find(b => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No caption from model");

  const parsed = extractJSON<Record<string, unknown>>(textBlock.text);
  const defaults = { caption: "", headline: "" };

  // Build CaptionResult keyed from PLATFORM_CONFIGS so youtube and any future
  // platforms are included without hand-maintaining this object shape.
  const captions = Object.fromEntries(
    Object.keys(PLATFORM_CONFIGS).map(p => [
      p,
      { ...defaults, ...(parsed[p] as object | undefined) },
    ]),
  ) as unknown as CaptionResult;

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

  const imageFilename = `copilot-${crypto.randomUUID()}.png`;
  await writeBuffer("generated", imageFilename, imageBuffer);
  const rawImageUrl = `/api/files/generated/${imageFilename}`;

  // F3: Single batched insert instead of N serial round-trips (one per platform).
  const rows = platforms.map(platform => {
    const cap = (captions as unknown as Record<string, { caption: string; headline: string }>)[platform] || { caption: "", headline: "" };
    return {
      creativeId,
      platform,
      aspectRatio: PLATFORM_CONFIGS[platform]?.aspectRatio || "1:1",
      rawImageUrl,
      compositedImageUrl: rawImageUrl,
      caption: cap.caption,
      headlineText: cap.headline,
      status: "generated" as const,
      sourceVariantId: sourceVariantId || null,
    };
  });

  const inserted = await db.insert(creativeVariantsTable).values(rows).returning({ id: creativeVariantsTable.id });
  const variantIds = inserted.map(r => r.id);

  return variantIds;
}

export interface SessionWithTurns {
  session: StudioSession;
  turns: (SessionTurn & { variantUrls?: string[] })[];
}

export async function getSessionWithTurns(sessionId: string): Promise<SessionWithTurns | null> {
  const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
  if (!session) return null;

  // F1: Cap at 100 most-recent turns to bound payload size. Fetch desc then
  // reverse in JS so the thread renders in chronological order.
  const turnsDesc = await db.select().from(sessionTurnsTable)
    .where(eq(sessionTurnsTable.sessionId, sessionId))
    .orderBy(desc(sessionTurnsTable.seq))
    .limit(100);
  const turns = turnsDesc.reverse();

  // F1: Single inArray query for all variant IDs instead of N per-turn round-trips.
  const allVariantIds = turns.flatMap(t => (t.resultVariantIds || []) as string[]);
  const variantsByIdMap = new Map<string, { compositedImageUrl: string | null; rawImageUrl: string | null }>();

  if (allVariantIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const allVariants = await db.select({
      id: creativeVariantsTable.id,
      compositedImageUrl: creativeVariantsTable.compositedImageUrl,
      rawImageUrl: creativeVariantsTable.rawImageUrl,
    }).from(creativeVariantsTable).where(inArray(creativeVariantsTable.id, allVariantIds));
    for (const v of allVariants) variantsByIdMap.set(v.id, v);
  }

  const enriched = turns.map(turn => {
    const variantIds = (turn.resultVariantIds || []) as string[];
    if (variantIds.length === 0) return turn;
    const firstVariantId = variantIds[0];
    const v = firstVariantId ? variantsByIdMap.get(firstVariantId) : undefined;
    const variantUrls = v ? [v.compositedImageUrl || v.rawImageUrl || ""] : [];
    return { ...turn, variantUrls };
  });

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

  // A5: Walk backwards from sourceTurn to find the nearest prior image-producing
  // turn with a non-null interactionId.  This restores the full edit chain so
  // subsequent edit_image turns continue from the right historical state.
  const IMAGE_PRODUCING_ACTIONS = new Set(["draft", "edit_image", "edit_region", "compare", "caption"]);
  const sourceSeq = sourceTurn?.seq ?? Infinity;

  const priorImageTurn = turns
    .filter(t =>
      t.role === "copilot" &&
      t.seq <= sourceSeq &&
      t.interactionId != null &&
      IMAGE_PRODUCING_ACTIONS.has(t.action ?? ""),
    )
    .sort((a, b) => a.seq - b.seq)
    .at(-1) ?? null;

  const restoredInteractionId = priorImageTurn?.interactionId ?? null;

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
  existingCreativeId?: string;
}): Promise<StudioSession> {
  const { brandId, briefText, createdBy, conceptId, intent, styleProfileId, personaId, existingCreativeId } = params;

  if (existingCreativeId) {
    const [existing] = await db.select().from(creativesTable)
      .where(eq(creativesTable.id, existingCreativeId));
    if (!existing) throw new Error("Creative not found");
    if (existing.brandId !== brandId) throw new Error("Creative does not belong to this brand");

    // Reuse an existing session for this creative (repeat opens of the same
    // plan item should land in the same session, not stack new ones).
    const [priorSession] = await db.select().from(studioSessionsTable)
      .where(eq(studioSessionsTable.creativeId, existing.id))
      .orderBy(desc(studioSessionsTable.updatedAt))
      .limit(1);
    if (priorSession) return priorSession;

    const [session] = await db.insert(studioSessionsTable).values({
      creativeId: existing.id,
      brandId,
      status: "drafting",
      createdBy,
      sessionTitle: briefText.slice(0, 80) || existing.name.slice(0, 80),
    }).returning();

    return session;
  }

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
  // B2: When set, the reservation row is deleted inside the same transaction
  // as the real cost_logs insert so no phantom row can survive a mid-flight crash.
  reservationId?: string;
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

  // C4: User turns are facts — insert immediately as 'done' (they have no async work to track).
  // C6: Persist region metadata so TurnCard can render the region annotation badge.
  const [userTurn] = await db.insert(sessionTurnsTable).values({
    sessionId,
    seq: nextSeq,
    role: "user",
    instruction: input.instruction,
    action: input.action,
    status: "done",
    instructionPayload: {
      platform: input.platform,
      compareCount: input.compareCount,
      region: input.region,
      schedules: input.schedules,
    },
    metadata: input.region ? { region: input.region } : null,
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

    // C3: takesFocus=false means the turn added a variant (e.g. fan-out YouTube
    // video card conversion) without changing the session's primary creative focus.
    const shouldUpdateFocus = result.takesFocus !== false;
    const activeVariantId = shouldUpdateFocus
      ? (result.variantIds[0] || session.activeVariantId)
      : session.activeVariantId;

    // C7: Derive thumbnailUrl from the new active variant when the action doesn't
    // supply one (edit_image, caption, etc. don't set thumbnailUrl on ActionResult).
    let thumbnailUrl = result.thumbnailUrl || session.thumbnailUrl;
    if (shouldUpdateFocus && result.variantIds.length > 0 && !result.thumbnailUrl) {
      const [newActiveVariant] = await db
        .select({
          compositedImageUrl: creativeVariantsTable.compositedImageUrl,
          rawImageUrl: creativeVariantsTable.rawImageUrl,
        })
        .from(creativeVariantsTable)
        .where(eq(creativeVariantsTable.id, result.variantIds[0]!));
      if (newActiveVariant) {
        thumbnailUrl = newActiveVariant.compositedImageUrl || newActiveVariant.rawImageUrl || thumbnailUrl;
      }
    }

    // C4: Wrap all completion writes in a single transaction so a mid-flight crash
    // cannot leave the turn marked 'done' without the session state update (or vice versa).
    await db.transaction(async (tx) => {
      await tx.update(sessionTurnsTable).set({
        status: "done",
        resultVariantIds: result.variantIds,
        interactionId: result.interactionId || null,
        costUsd: result.costUsd,
        durationMs,
        metadata: result.metadata || null,
        updatedAt: now,
      }).where(eq(sessionTurnsTable.id, copilotTurn.id));

      await tx.update(studioSessionsTable).set({
        imageInteractionId: result.interactionId || session.imageInteractionId,
        videoInteractionId: result.videoInteractionId || session.videoInteractionId,
        activeVariantId,
        thumbnailUrl,
        lastTurnSummary: result.summary,
        status: "refining",
        totalCostUsd: sql<number>`${studioSessionsTable.totalCostUsd} + ${result.costUsd || 0}`,
        updatedAt: now,
      }).where(eq(studioSessionsTable.id, sessionId));

      if (result.costUsd && result.costUsd > 0) {
        await tx.insert(costLogsTable).values({
          creativeId: creative.id,
          service: "copilot",
          operation: input.action,
          model: result.modelUsed || COPILOT_MODELS.NANO_BANANA_MODEL,
          costUsd: result.costUsd,
        });
      }

      // B2: Delete the budget reservation row atomically with the real cost insert
      // so no phantom row remains if the process crashes between the two writes.
      if (params.reservationId) {
        await tx.delete(costLogsTable).where(eq(costLogsTable.id, params.reservationId));
      }
    });

    if (input.action === "edit_image" || input.action === "edit_region" || input.action === "caption") {
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
        // Surface sourceVariantId for convert_video turns triggered from fan-out
        // YouTube cards — lets the frontend map the new video variant back to
        // the card that requested the conversion.
        ...(result.metadata?.sourceVariantId ? { sourceVariantId: result.metadata.sourceVariantId } : {}),
      },
    });
    return refreshed;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Distinguish a cancelled turn (client disconnect / SSE timeout fired the
    // AbortSignal) from a real failure: mark it 'cancelled' immediately so the
    // session is never stuck showing a spinner until the startup sweep runs.
    const wasAborted =
      input.signal?.aborted === true ||
      (err instanceof Error && err.name === "AbortError");

    if (wasAborted) {
      logger.info({ sessionId, action: input.action }, "Turn cancelled by abort signal");
    } else {
      logger.error({ err, sessionId, action: input.action }, "Turn execution failed");
    }

    await db.update(sessionTurnsTable).set({
      status: wasAborted ? "cancelled" : "error",
      error: wasAborted ? "Turn cancelled" : errMsg,
      updatedAt: new Date(),
    }).where(eq(sessionTurnsTable.id, copilotTurn.id));

    // B2: On error, eagerly release the reservation so the budget gate is
    // not permanently blocked by a failed turn.
    if (params.reservationId) {
      await db.delete(costLogsTable)
        .where(eq(costLogsTable.id, params.reservationId))
        .catch((e: unknown) => {
          logger.error({ err: e, reservationId: params.reservationId }, "Failed to release budget reservation on turn error");
        });
    }

    onProgress({ type: "error", message: errMsg });
    throw err;
  }
}

interface ActionResult {
  variantIds: string[];
  interactionId?: string;
  videoInteractionId?: string;
  costUsd: number;
  summary: string;
  thumbnailUrl?: string;
  metadata?: Record<string, unknown>;
  modelUsed?: string;
  // C3: When false, executeTurn does NOT advance the session's activeVariantId.
  // Use for actions that produce a side-output (e.g. per-card YouTube video
  // conversion from a fan-out card) without changing the primary creative focus.
  takesFocus?: boolean;
}

async function executeActionCore(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  userId: string;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;
  // D1: Check abort before dispatching to the action — avoids starting model
  // calls after the client already disconnected.
  if (input.signal?.aborted) throw new Error("Turn cancelled before action dispatch");

  switch (input.action) {
    case "draft": return executeDraftWithQa({ session, creative, input, onProgress });
    case "edit_image": return executeEditImageWithQa({ session, creative, input, onProgress });
    case "edit_region": return executeEditRegion({ session, creative, input, onProgress });
    case "caption": return executeCaption({ session, creative, input, onProgress });
    case "compare": return executeCompare({ session, creative, input, onProgress });
    case "convert_video": return executeConvertVideo({ session, creative, input, onProgress });
    case "edit_video": return executeEditVideo({ session, creative, input, onProgress });
    case "fan_out": return executeFanOut({ session, creative, input, onProgress });
    case "schedule": return executeSchedule({ session, creative, input, onProgress });
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
    signal: input.signal,
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

/**
 * Load Asset Library images to attach to an edit turn as model reference slots.
 *
 * Two paths:
 *  - Explicit: the client sent assetIds (attach-asset picker). Assets are
 *    scoped to the creative's brand so callers can't attach another brand's files.
 *  - Auto-match: no explicit ids — scan the brand's assets for names mentioned
 *    (case-insensitively) in the instruction, e.g. "add the Crown U logo".
 *
 * Returns at most MAX_ATTACHED_ASSETS slots; assets without a readable image
 * file are skipped (never fail the whole turn over one missing file).
 */
const MAX_ATTACHED_ASSETS = 3;

async function loadAttachedAssetSlots(params: {
  brandId: string;
  instruction: string;
  assetIds?: string[];
}): Promise<{ slots: ImageSlot[]; names: string[] }> {
  const { brandId, instruction, assetIds } = params;
  const { inArray } = await import("drizzle-orm");

  let candidates: Array<typeof assetsTable.$inferSelect> = [];

  if (assetIds && assetIds.length > 0) {
    candidates = await db.select().from(assetsTable)
      .where(and(inArray(assetsTable.id, assetIds.slice(0, MAX_ATTACHED_ASSETS)), eq(assetsTable.brandId, brandId)));
  } else if (instruction.trim().length >= 3) {
    // Auto-match: brand assets whose name appears in the instruction text.
    const brandAssets = await db.select().from(assetsTable)
      .where(eq(assetsTable.brandId, brandId));
    const lower = instruction.toLowerCase();
    candidates = brandAssets
      .filter(a => a.name.trim().length >= 3 && lower.includes(a.name.trim().toLowerCase()))
      .slice(0, MAX_ATTACHED_ASSETS);
  }

  const slots: ImageSlot[] = [];
  const names: string[] = [];
  for (const asset of candidates) {
    if (slots.length >= MAX_ATTACHED_ASSETS) break;
    if (!asset.fileUrl) continue;
    const loc = resolveUrl(asset.fileUrl);
    if (!loc) continue;
    // Only image assets can be model reference slots — a PDF or font file
    // would make the model request fail outright.
    const mime = asset.mimeType || contentTypeFor(loc.filename);
    if (!mime.startsWith("image/")) {
      logger.warn({ assetId: asset.id, name: asset.name, mime }, "Attached asset is not an image; skipping");
      continue;
    }
    const buf = await readBuffer(loc);
    if (!buf) {
      logger.warn({ assetId: asset.id, name: asset.name }, "Attached asset image could not be read; skipping");
      continue;
    }
    slots.push({
      imageBuffer: buf,
      mimeType: mime,
      slot: "object",
      description: `Brand asset "${asset.name}"${asset.description ? ` — ${asset.description}` : ""}. Reproduce this exact asset faithfully as shown — do not redesign, restyle, or invent a different version of it.`,
    });
    names.push(asset.name);
  }
  return { slots, names };
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

  // Attach real Asset Library images (picker selection or names mentioned in
  // the instruction) so the model uses the actual asset instead of inventing one.
  const attached = await loadAttachedAssetSlots({
    brandId: creative.brandId,
    instruction: input.instruction,
    assetIds: input.assetIds,
  });
  if (attached.names.length > 0) {
    onProgress({ type: "progress", step: "image", message: `Using library asset${attached.names.length > 1 ? "s" : ""}: ${attached.names.join(", ")}` });
  }

  onProgress({ type: "progress", step: "image", message: `Editing image (targeted preserving edit, not a re-roll)...` });

  const imageResult = await runImageInteraction({
    prompt: input.instruction,
    slots: attached.slots,
    previousInteractionId: session.imageInteractionId,
    aspectRatio: "1:1",
    signal: input.signal,
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

    // Merge: start from existing captions, then apply the newly generated platform on top.
    // Derive the full key set from PLATFORM_CONFIGS so youtube is always included.
    const defaults = { caption: "", headline: "" };
    captions = Object.fromEntries(
      Object.keys(PLATFORM_CONFIGS).map(p => [
        p,
        (existing as Record<string, { caption: string; headline: string }>)[p] || defaults,
      ]),
    ) as unknown as CaptionResult;
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
    modelUsed: AI_MODELS.CLAUDE_SONNET,
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

  // F4: Generate all N takes concurrently — each call is independent so there
  // is no ordering dependency.  The UI receives the takes in a deterministic
  // order (0→N-1) because Promise.all preserves input order.
  onProgress({ type: "progress", step: "compare", message: `Generating ${count} takes concurrently...` });
  const takeResults = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      runImageInteraction({
        prompt: `${artDirection}\n\nVARIATION ${i + 1}: Fresh composition, same brief.`,
        slots: allSlots,
        previousInteractionId: null,
        aspectRatio: "1:1",
        signal: input.signal,
      }),
    ),
  );

  // Caption generation and variant saves are also batched.
  const takeOutputs = await Promise.all(
    takeResults.map(async (result, i) => {
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

      return { result, variantIds };
    }),
  );

  // One canonical (first-platform) variant ID per take — UI renders these as the N take thumbnails.
  const canonicalTakeIds: string[] = [];
  const perTakeVariantIds: string[][] = [];
  const perTakeInteractionIds: string[] = [];
  let totalCost = 0;

  for (const { result, variantIds } of takeOutputs) {
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

// ============================================================================
// Phase 2: QA pass
// ============================================================================

/**
 * Detect an image's real mime type from its magic bytes. Stored mime types /
 * file extensions can be wrong (image models sometimes return JPEG bytes that
 * get saved as .png), and Anthropic hard-rejects a media_type mismatch.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const COPILOT_QA_SYSTEM = `You are a quality-control reviewer for a social media image. Check:
1. Did the edit instruction appear to be honored?
2. Is the image presentable (no obvious clipping, artifacts, or glitches)?
3. Are brand rules respected — no banned terms, no off-brand visual elements, voice and style consistent with the brand guidelines provided?
Return ONLY valid JSON, no markdown fences: {"ok": boolean, "issue": string|null, "correctionHint": string|null}`;

async function runCopilotQaPass(
  imageBuffer: Buffer,
  instruction: string,
  brandContext?: string,
): Promise<{ ok: boolean; issue?: string; correctionHint?: string }> {
  try {
    const brandSection = brandContext
      ? `\nBrand rules to verify:\n${brandContext}\n`
      : "";
    const response = await geminiAi.models.generateContent({
      model: COPILOT_MODELS.QA_MODEL,
      contents: [{
        role: "user",
        parts: [
          {
            inlineData: {
              data: imageBuffer.toString("base64"),
              mimeType: sniffImageMime(imageBuffer) || "image/png",
            },
          },
          {
            text: `Original instruction: "${instruction}"${brandSection}\n\n${COPILOT_QA_SYSTEM}`,
          },
        ],
      }],
    });
    const text = (response.candidates?.[0]?.content?.parts ?? [])
      .filter((p: { text?: string }) => p.text)
      .map((p: { text?: string }) => p.text)
      .join("") || "{}";
    const parsed = extractJSON<Record<string, unknown>>(text);
    return {
      ok: parsed.ok === true,
      issue: typeof parsed.issue === "string" ? parsed.issue : undefined,
      correctionHint: typeof parsed.correctionHint === "string" ? parsed.correctionHint : undefined,
    };
  } catch (err) {
    logger.warn({ err }, "Copilot QA pass failed — skipping gate");
    return { ok: true };
  }
}

/**
 * Post-generation QA: read a variant image, run the QA model, optionally apply
 * one corrective image interaction and update the variant rows in-place.
 *
 * When a correction fires it is surfaced as its own copilot session turn so the
 * user can see it in the turn history (max one corrective turn per QA pass).
 */
async function applyQaPass(params: {
  variantIds: string[];
  instruction: string;
  interactionId?: string;
  sessionId: string;
  parentAction: TurnAction;
  creativeId: string;
  brandId: string;
  onProgress: ProgressCallback;
  // F5: Callers that already hold the in-memory image buffer (executeDraft,
  // executeEditImage, executeEditRegion) can pass it here to skip the
  // re-read from storage — one fewer round-trip per QA pass.
  imageBuffer?: Buffer;
  // D1: Optional abort signal — if set, QA corrective image calls are also
  // cancelled when the client disconnects (same as the parent turn).
  signal?: AbortSignal;
}): Promise<{ interactionId?: string; qaRetried: boolean; qaIssue?: string }> {
  const { variantIds, instruction, interactionId, sessionId, parentAction, creativeId, brandId, onProgress } = params;

  if (!variantIds.length || !interactionId) {
    return { interactionId, qaRetried: false };
  }

  // F5: Use the caller-supplied buffer if available, otherwise read from storage.
  let imageBuffer = params.imageBuffer;
  if (!imageBuffer) {
    const [primaryVariant] = await db
      .select()
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.id, variantIds[0]!));

    if (!primaryVariant?.rawImageUrl) return { interactionId, qaRetried: false };

    const loc = resolveUrl(primaryVariant.rawImageUrl);
    if (!loc) return { interactionId, qaRetried: false };
    imageBuffer = await readBuffer(loc) ?? undefined;
    if (!imageBuffer) return { interactionId, qaRetried: false };
  }

  // Build brand-rule context for QA verification so the model checks both
  // instruction adherence and brand-compliance in a single pass.
  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  const brandContext = brand
    ? [
        brand.name ? `Brand: ${brand.name}` : null,
        brand.voiceDescription ? `Voice/style: ${brand.voiceDescription}` : null,
      ].filter(Boolean).join(". ")
    : undefined;

  onProgress({ type: "progress", step: "qa", message: "QA: reviewing edit quality and brand compliance..." });
  const verdict = await runCopilotQaPass(imageBuffer, instruction, brandContext);

  if (verdict.ok || !verdict.correctionHint) {
    return { interactionId, qaRetried: false };
  }

  onProgress({
    type: "progress",
    step: "qa",
    message: `QA: correcting — ${verdict.issue ?? "refining composition"}`,
  });

  // Reserve a DB turn row for the corrective pass so it appears in history.
  const [lastTurn] = await db
    .select()
    .from(sessionTurnsTable)
    .where(eq(sessionTurnsTable.sessionId, sessionId))
    .orderBy(desc(sessionTurnsTable.seq))
    .limit(1);
  const qaSeq = (lastTurn?.seq ?? 0) + 1;

  const [qaTurn] = await db
    .insert(sessionTurnsTable)
    .values({
      sessionId,
      seq: qaSeq,
      role: "copilot",
      action: parentAction,
      status: "running",
      instruction: `QA correction: ${verdict.correctionHint}`,
    })
    .returning();

  const qaStartMs = Date.now();
  // One image generation for the corrective pass.
  const correctionCostUsd = estimateImagenCost(1);

  try {
    const corrected = await runImageInteraction({
      prompt: `Correction needed: ${verdict.correctionHint}. Original instruction: "${instruction}"`,
      slots: [],
      previousInteractionId: interactionId,
      aspectRatio: "1:1",
      // D1: If the client disconnected, the QA corrective call is also cancelled.
      signal: params.signal,
    });

    const correctedFilename = `copilot-qa-${crypto.randomUUID()}.png`;
    await writeBuffer("generated", correctedFilename, corrected.imageBuffer);
    const correctedUrl = `/api/files/generated/${correctedFilename}`;

    for (const vid of variantIds) {
      await db
        .update(creativeVariantsTable)
        .set({ rawImageUrl: correctedUrl, compositedImageUrl: correctedUrl })
        .where(eq(creativeVariantsTable.id, vid));
    }

    if (qaTurn) {
      await db
        .update(sessionTurnsTable)
        .set({
          status: "done",
          resultVariantIds: variantIds,
          interactionId: corrected.interactionId,
          costUsd: correctionCostUsd,
          durationMs: Date.now() - qaStartMs,
          metadata: { isQaCorrection: true, issue: verdict.issue, correctionHint: verdict.correctionHint },
          updatedAt: new Date(),
        })
        .where(eq(sessionTurnsTable.id, qaTurn.id));
    }

    // Log the corrective generation cost separately so the cost dashboard
    // accurately reflects the extra generation spend.
    await db.insert(costLogsTable).values({
      creativeId,
      service: "copilot",
      operation: "qa_correction",
      model: COPILOT_MODELS.NANO_BANANA_MODEL,
      costUsd: correctionCostUsd,
    });

    onProgress({ type: "progress", step: "qa", message: "QA: correction applied", done: true });
    return { interactionId: corrected.interactionId, qaRetried: true, qaIssue: verdict.issue };
  } catch (err) {
    // Same abort-vs-error distinction as executeTurn: a cancelled QA pass must
    // not leave a 'running' or misleading 'error' row behind.
    const qaAborted =
      params.signal?.aborted === true ||
      (err instanceof Error && err.name === "AbortError");
    if (qaTurn) {
      await db
        .update(sessionTurnsTable)
        .set({
          status: qaAborted ? "cancelled" : "error",
          error: qaAborted ? "Turn cancelled" : String(err),
          updatedAt: new Date(),
        })
        .where(eq(sessionTurnsTable.id, qaTurn.id));
    }
    logger.warn({ err }, "QA corrective edit failed — keeping original image");
    return { interactionId, qaRetried: false };
  }
}

async function executeDraftWithQa(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const result = await executeDraft(params);
  const qa = await applyQaPass({
    variantIds: result.variantIds,
    instruction: params.input.instruction,
    interactionId: result.interactionId,
    sessionId: params.session.id,
    parentAction: "draft",
    creativeId: params.creative.id,
    brandId: params.creative.brandId,
    onProgress: params.onProgress,
    signal: params.input.signal,
    // F5: executeDraft stored imageBuffer in thumbnailUrl path but the original
    // buffer is not returned by ActionResult — QA re-reads from storage for draft.
  });
  return {
    ...result,
    interactionId: qa.interactionId ?? result.interactionId,
    metadata: { ...(result.metadata || {}), qaRetried: qa.qaRetried, qaIssue: qa.qaIssue },
  };
}

async function executeEditImageWithQa(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const result = await executeEditImage(params);
  const qa = await applyQaPass({
    variantIds: result.variantIds,
    instruction: params.input.instruction,
    interactionId: result.interactionId,
    sessionId: params.session.id,
    parentAction: "edit_image",
    creativeId: params.creative.id,
    brandId: params.creative.brandId,
    onProgress: params.onProgress,
    signal: params.input.signal,
  });
  return {
    ...result,
    interactionId: qa.interactionId ?? result.interactionId,
    metadata: { ...(result.metadata || {}), qaRetried: qa.qaRetried, qaIssue: qa.qaIssue },
  };
}

// ============================================================================
// Phase 2: edit_region
// ============================================================================

async function executeEditRegion(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  if (!session.imageInteractionId) {
    throw new Error("No previous image interaction to edit. Run a draft or edit first.");
  }

  const region = input.region;
  if (!region) {
    throw new Error("edit_region requires a region bounding box { x0, y0, x1, y1 }.");
  }

  const regionPrompt =
    `Apply ONLY within the region bounded by normalized coordinates ` +
    `top-left [${region.x0.toFixed(3)}, ${region.y0.toFixed(3)}] ` +
    `to bottom-right [${region.x1.toFixed(3)}, ${region.y1.toFixed(3)}]: ` +
    `${input.instruction}. ` +
    `Keep all content outside this region completely unchanged.`;

  onProgress({
    type: "progress",
    step: "image",
    message: `Applying region edit within [${(region.x0 * 100).toFixed(0)}%, ${(region.y0 * 100).toFixed(0)}%] to [${(region.x1 * 100).toFixed(0)}%, ${(region.y1 * 100).toFixed(0)}%]...`,
  });

  // Attach real Asset Library images for region edits too (e.g. "add the
  // Crown U logo" within a selected region).
  const attached = await loadAttachedAssetSlots({
    brandId: creative.brandId,
    instruction: input.instruction,
    assetIds: input.assetIds,
  });
  if (attached.names.length > 0) {
    onProgress({ type: "progress", step: "image", message: `Using library asset${attached.names.length > 1 ? "s" : ""}: ${attached.names.join(", ")}` });
  }

  const imageResult = await runImageInteraction({
    prompt: regionPrompt,
    slots: attached.slots,
    previousInteractionId: session.imageInteractionId,
    aspectRatio: "1:1",
    signal: input.signal,
  });

  onProgress({ type: "progress", step: "image", message: "Region edit applied", done: true });
  onProgress({ type: "progress", step: "captions", message: "Updating captions..." });

  const { captions } = await buildImageAwareCaption({
    brandId: creative.brandId,
    briefText: input.instruction || creative.briefText || "",
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
    label: "edit-region",
  });

  const qa = await applyQaPass({
    variantIds,
    instruction: input.instruction,
    interactionId: imageResult.interactionId,
    sessionId: session.id,
    parentAction: "edit_region",
    creativeId: creative.id,
    brandId: creative.brandId,
    onProgress,
    signal: input.signal,
  });

  const costUsd = estimateImagenCost(1) + estimateClaudeCost();

  return {
    variantIds,
    interactionId: qa.interactionId ?? imageResult.interactionId,
    costUsd,
    summary: `Region edit applied within [${(region.x0 * 100).toFixed(0)}%,${(region.y0 * 100).toFixed(0)}%] to [${(region.x1 * 100).toFixed(0)}%,${(region.y1 * 100).toFixed(0)}%]`,
    metadata: { instruction: input.instruction, region, qaRetried: qa.qaRetried, qaIssue: qa.qaIssue },
    modelUsed: COPILOT_MODELS.NANO_BANANA_MODEL,
  };
}

// ============================================================================
// Phase 2: convert_video / edit_video
// ============================================================================

async function executeConvertVideo(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  // When sourceVariantId is supplied (e.g. from a fan-out YouTube card's inline
  // "Convert to video" button) use that variant as the source image instead of
  // the session's current activeVariantId.  This allows per-card conversion
  // without changing the active variant.
  const targetVariantId = input.sourceVariantId || session.activeVariantId;
  if (!targetVariantId) {
    throw new Error("No active image to convert. Run a draft or edit first.");
  }

  onProgress({ type: "progress", step: "image", message: "Loading current image for video conversion..." });

  const [variant] = await db
    .select()
    .from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, targetVariantId));
  if (!variant) throw new Error("Active variant not found");

  // Ownership check: when sourceVariantId was explicitly supplied (fan-out card
  // button), verify the variant belongs to this creative to prevent cross-creative
  // targeting.  Sessions are already scoped to a creative; activeVariantId is
  // implicitly trusted.
  if (input.sourceVariantId && (variant as Record<string, unknown>).creativeId !== creative.id) {
    throw new Error("Variant does not belong to this creative and cannot be converted.");
  }

  const imageUrl = variant.compositedImageUrl || variant.rawImageUrl;
  if (!imageUrl) throw new Error("Active variant has no image");

  const loc = resolveUrl(imageUrl);
  if (!loc) throw new Error("Cannot resolve image URL");
  const imageBuffer = await readBuffer(loc);
  if (!imageBuffer) throw new Error("Could not read image buffer");

  onProgress({
    type: "progress",
    step: "video",
    message: `Converting image to video via ${COPILOT_MODELS.OMNI_VIDEO_MODEL}...`,
  });

  // When converting a fan-out YouTube card, use the YouTube aspect ratio (16:9).
  // Fall back to explicit platform param, then to the source variant's own aspectRatio.
  const aspectRatio =
    (input.platform && PLATFORM_CONFIGS[input.platform]?.aspectRatio) ??
    (variant.aspectRatio || "1:1");

  const videoResult = await runVideoInteraction({
    prompt: input.instruction || "Convert this image into a short, dynamic video clip. Animate the subject naturally with subtle movement, camera drift, and ambient motion. Keep the brand framing intact.",
    imageBuffer,
    imageMimeType: contentTypeFor(loc.filename) || "image/png",
    previousInteractionId: null,
    aspectRatio,
    signal: input.signal,
  });

  onProgress({ type: "progress", step: "video", message: "Video generated", done: true });
  onProgress({ type: "progress", step: "saving", message: "Saving video variant..." });

  const videoFilename = `copilot-video-${crypto.randomUUID()}.mp4`;
  await writeBuffer("generated", videoFilename, videoResult.videoBuffer);
  const videoUrl = `/api/files/generated/${videoFilename}`;

  // Use the source variant's platform so the video card stays associated with
  // the same platform slot (e.g. "youtube" from fan-out).
  const platform = input.platform || (variant.platform as string | null) || "all";

  const [videoVariant] = await db
    .insert(creativeVariantsTable)
    .values({
      creativeId: creative.id,
      platform,
      aspectRatio,
      rawImageUrl: imageUrl,
      compositedImageUrl: imageUrl,
      videoUrl,
      status: "generated",
      sourceVariantId: targetVariantId,
    })
    .returning({ id: creativeVariantsTable.id });

  if (!videoVariant) throw new Error("Failed to save video variant");

  const durationSeconds = estimateVideoDurationSeconds(videoResult.videoBuffer.length);
  const costUsd = durationSeconds * COST_ESTIMATES.VIDEO_COST_PER_SECOND_USD;

  return {
    variantIds: [videoVariant.id],
    videoInteractionId: videoResult.interactionId,
    costUsd,
    summary: "Image converted to video — edit the video with follow-up instructions",
    thumbnailUrl: imageUrl,
    // sourceVariantId in metadata lets the frontend update fan-out card state
    // when this conversion was triggered from a YouTube fan-out card button.
    metadata: { videoUrl, aspectRatio, durationSeconds, costUsd, sourceVariantId: targetVariantId },
    modelUsed: COPILOT_MODELS.OMNI_VIDEO_MODEL,
    // C3: Fan-out card conversions don't change the session's primary creative
    // focus — the YouTube video is a side-output, not a new main variant.
    takesFocus: input.sourceVariantId ? false : undefined,
  };
}

async function executeEditVideo(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  if (!session.videoInteractionId) {
    throw new Error("No previous video interaction to edit. Convert an image to video first.");
  }

  onProgress({
    type: "progress",
    step: "video",
    message: `Editing video via ${COPILOT_MODELS.OMNI_VIDEO_MODEL}...`,
  });

  // Preserve the source variant's platform and aspect ratio so follow-up
  // video edits stay associated with the same platform slot (e.g. YouTube 16:9).
  const activeVariantId = session.activeVariantId;
  const [sourceVariant] = activeVariantId
    ? await db.select().from(creativeVariantsTable).where(eq(creativeVariantsTable.id, activeVariantId))
    : [null];
  const inheritedAspectRatio = (input.platform && PLATFORM_CONFIGS[input.platform]?.aspectRatio)
    || (sourceVariant as { aspectRatio?: string | null } | null)?.aspectRatio
    || "1:1";
  const inheritedPlatform = input.platform
    || (sourceVariant as { platform?: string | null } | null)?.platform
    || "all";

  const videoResult = await runVideoInteraction({
    prompt: input.instruction,
    signal: input.signal,
    imageBuffer: null,
    previousInteractionId: session.videoInteractionId,
    aspectRatio: inheritedAspectRatio,
  });

  onProgress({ type: "progress", step: "video", message: "Video edit applied", done: true });
  onProgress({ type: "progress", step: "saving", message: "Saving edited video..." });

  const videoFilename = `copilot-video-edit-${crypto.randomUUID()}.mp4`;
  await writeBuffer("generated", videoFilename, videoResult.videoBuffer);
  const videoUrl = `/api/files/generated/${videoFilename}`;

  const thumbnailUrl = session.thumbnailUrl || undefined;

  const [videoVariant] = await db
    .insert(creativeVariantsTable)
    .values({
      creativeId: creative.id,
      platform: inheritedPlatform,
      aspectRatio: inheritedAspectRatio,
      rawImageUrl: thumbnailUrl || "",
      compositedImageUrl: thumbnailUrl || "",
      videoUrl,
      status: "generated",
      sourceVariantId: activeVariantId || undefined,
    })
    .returning({ id: creativeVariantsTable.id });

  if (!videoVariant) throw new Error("Failed to save video variant");

  const durationSeconds = estimateVideoDurationSeconds(videoResult.videoBuffer.length);
  const costUsd = durationSeconds * COST_ESTIMATES.VIDEO_COST_PER_SECOND_USD;

  return {
    variantIds: [videoVariant.id],
    videoInteractionId: videoResult.interactionId,
    costUsd,
    summary: "Video edit applied — targeted change while preserving the clip",
    thumbnailUrl,
    metadata: { videoUrl, durationSeconds, costUsd },
    modelUsed: COPILOT_MODELS.OMNI_VIDEO_MODEL,
  };
}

// ============================================================================
// Phase 2: fan_out
// ============================================================================


// E1: buildFanOutCaptions removed — fan_out now uses the canonical
// buildImageAwareCaption (with full brand contract) instead of the deleted
// duplicate.  See executeFanOut below.

async function executeFanOut(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { session, creative, input, onProgress } = params;

  const activeVariantId = session.activeVariantId;
  if (!activeVariantId) {
    throw new Error("No active image for fan-out. Run a draft or edit first.");
  }

  onProgress({ type: "progress", step: "fan_out", message: "Loading current image..." });

  const [variant] = await db
    .select()
    .from(creativeVariantsTable)
    .where(eq(creativeVariantsTable.id, activeVariantId));
  if (!variant) throw new Error("Active variant not found");

  const imageUrl = variant.compositedImageUrl || variant.rawImageUrl;
  if (!imageUrl) throw new Error("Active variant has no image");

  const loc = resolveUrl(imageUrl);
  if (!loc) throw new Error("Cannot resolve image URL");
  const imageBuffer = await readBuffer(loc);
  if (!imageBuffer) throw new Error("Could not read image buffer");

  onProgress({ type: "progress", step: "fan_out", message: "Detecting subject for smart reframe..." });

  const { focal, box } = await detectSubject(imageBuffer);

  onProgress({ type: "progress", step: "fan_out", message: "Generating image-aware captions for all platforms..." });

  // E1: Use the canonical buildImageAwareCaption (with full brand contract: voice, taste,
  // voiceExamples, bannedTerms) instead of the deleted standalone buildFanOutCaptions.
  const { captions: fanOutCaptionResult } = await buildImageAwareCaption({
    brandId: creative.brandId,
    briefText: input.instruction || creative.briefText || "",
    imageBuffer,
    imageMimeType: contentTypeFor(loc.filename) || "image/png",
    intent: creative.intent,
  });
  const fanOutCaptions = fanOutCaptionResult as unknown as Record<string, { caption: string; headline: string }>;

  // Fetch performance insights once; used for insights-backed schedule times
  // per platform instead of hardcoded hour slots.
  const intentInsights = await getIntentInsights({
    brandId: creative.brandId,
    intent: creative.intent,
  }).catch(() => null);

  // Build a lookup from insights: use the best-time suggestedHour as the
  // schedule anchor for all platforms. PlatformInsight doesn't carry per-slot
  // timing, so we use the leading TimeInsight (highest engagement day-part).
  // Falls back to 10am when there is no historical data.
  const bestHour = intentInsights?.bestTimes?.[0]?.suggestedHour ?? 10;

  // C2: Spread platforms across adjacent slots (+1h each) but clamp to hour 23
  // to avoid rolling midnight.  When clamped, add idx×10 minutes so ordering
  // is still distinct and no two platforms land on an identical timestamp.
  const platformOrder = Object.keys(PLATFORM_CONFIGS);
  const insightSlot = (platform: string): { hour: number; minutes: number } => {
    const idx = platformOrder.indexOf(platform);
    const rawHour = bestHour + idx;
    const clamped = rawHour > 23;
    const hour = Math.min(rawHour, 23);
    const minutes = clamped ? (idx * 10) % 60 : 0;
    return { hour, minutes };
  };

  const now = new Date();

  const nextSlot = (platform: string): Date => {
    const { hour, minutes } = insightSlot(platform);
    const d = new Date(now);
    d.setHours(hour, minutes, 0, 0);
    if (d.getTime() <= now.getTime() + 60 * 60 * 1000) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  };

  // Measure source image dimensions once so predictClip can be called per platform.
  const { width: srcW, height: srcH } = await imageDimensions(imageBuffer);
  const sourceAspect = srcW / srcH;

  onProgress({ type: "progress", step: "fan_out", message: "Creating platform variants..." });

  const platformCards: FanOutPlatformCard[] = [];
  const allVariantIds: string[] = [];
  let outpaintCount = 0;

  for (const [platformKey, config] of Object.entries(PLATFORM_CONFIGS)) {
    try {
      const [targetW, targetH] = config.aspectRatio.split(":").map(Number) as [number, number];
      const targetAspect = targetW / targetH;

      // Use the existing focal-point pipeline: when a standard crop would clip
      // the subject, escalate to generative outpainting (N1); otherwise reframe.
      const willClip = predictClip(box, focal, sourceAspect, targetAspect);
      let outputBuffer: Buffer;
      if (willClip) {
        outputBuffer = await outpaintImage(
          imageBuffer,
          contentTypeFor(loc.filename) || "image/png",
          config.aspectRatio,
          input.instruction || creative.briefText || undefined,
        );
        outpaintCount++;
      } else {
        outputBuffer = await reframeImage(imageBuffer, config.width, config.height, focal, box);
      }

      const filename = `copilot-fanout-${platformKey}-${crypto.randomUUID()}.png`;
      await writeBuffer("generated", filename, outputBuffer);
      const reframedUrl = `/api/files/generated/${filename}`;

      const cap = fanOutCaptions[platformKey] ?? { caption: "", headline: "" };

      const [variantRow] = await db
        .insert(creativeVariantsTable)
        .values({
          creativeId: creative.id,
          platform: platformKey,
          aspectRatio: config.aspectRatio,
          rawImageUrl: reframedUrl,
          compositedImageUrl: reframedUrl,
          caption: cap.caption,
          headlineText: cap.headline,
          status: "generated",
          sourceVariantId: activeVariantId,
        })
        .returning({ id: creativeVariantsTable.id });

      if (!variantRow) continue;
      allVariantIds.push(variantRow.id);

      platformCards.push({
        platform: platformKey,
        variantId: variantRow.id,
        imageUrl: reframedUrl,
        caption: cap.caption,
        headline: cap.headline,
        // Insights-backed schedule time: uses historical engagement data
        // from performance-insights.ts rather than hardcoded hour slots.
        suggestedAt: nextSlot(platformKey).toISOString(),
        // YouTube is a video platform — the thumbnail reframe is stored so the
        // card appears in the inline grid, but the user must run convert_video
        // before scheduling.  Card renders a "Generate video first" CTA.
        ...(platformKey === "youtube" ? { requiresVideo: true } : {}),
      });
    } catch (err) {
      logger.warn({ err, platform: platformKey }, "Fan-out reframe failed for platform — skipping");
    }
  }

  if (allVariantIds.length === 0) {
    throw new Error("Fan-out produced no platform variants");
  }

  // Caption generation (Claude) + subject detection (Gemini text) +
  // any outpaint calls (each is one Imagen generation).
  const costUsd = estimateClaudeCost() + estimateGeminiTextCost() + estimateImagenCost(outpaintCount);

  return {
    variantIds: allVariantIds,
    costUsd,
    summary: `Platform set: ${platformCards.length} platforms ready`,
    metadata: { platforms: platformCards },
    modelUsed: AI_MODELS.CLAUDE_SONNET,
  };
}

// ============================================================================
// Phase 2: schedule
// ============================================================================

async function executeSchedule(params: {
  session: StudioSession;
  creative: typeof creativesTable.$inferSelect;
  input: TurnInput;
  onProgress: ProgressCallback;
}): Promise<ActionResult> {
  const { creative, input, onProgress } = params;
  const schedules = input.schedules ?? [];

  if (schedules.length === 0) {
    throw new Error("No schedules provided. Approve platforms and set times before scheduling.");
  }

  onProgress({
    type: "progress",
    step: "schedule",
    message: `Scheduling ${schedules.length} platform post${schedules.length !== 1 ? "s" : ""}...`,
  });

  const [creativeRow] = await db
    .select({ intent: creativesTable.intent })
    .from(creativesTable)
    .where(eq(creativesTable.id, creative.id));

  // Ownership check: verify every variantId belongs to this creative before
  // inserting calendar rows. Prevents cross-creative IDOR-style scheduling.
  // Collect the full variant rows so we can inspect videoUrl below.
  const ownedVariants = new Map<string, Record<string, unknown>>();
  for (const sched of schedules) {
    const [variant] = await db
      .select()
      .from(creativeVariantsTable)
      .where(
        and(
          eq(creativeVariantsTable.id, sched.variantId),
          eq(creativeVariantsTable.creativeId, creative.id),
        ),
      );
    if (!variant) {
      throw new Error(
        `Variant "${sched.variantId}" does not belong to this creative and cannot be scheduled.`,
      );
    }
    ownedVariants.set(sched.variantId, variant as Record<string, unknown>);
  }

  // Mirror the platform-to-account-platform mapping used by publish-scheduler
  // so we can resolve the correct connected social account for each entry.
  const ACCOUNT_PLATFORM_MAP: Record<string, string> = {
    twitter:         "twitter",
    instagram_feed:  "instagram",
    instagram_story: "instagram",
    linkedin:        "linkedin",
    tiktok:          "tiktok",
    youtube:         "youtube",
  };

  // Load all connected accounts for this brand once, keyed by account platform.
  const brandAccounts = await db
    .select({ id: socialAccountsTable.id, platform: socialAccountsTable.platform })
    .from(socialAccountsTable)
    .where(
      and(
        eq(socialAccountsTable.brandId, creative.brandId),
        eq(socialAccountsTable.status, "connected"),
      ),
    );
  const accountByPlatform = new Map(brandAccounts.map(a => [a.platform, a.id]));

  // Validate that every scheduled platform has a connected account before
  // inserting any rows — fail fast with a clear message so the user can
  // connect the missing account in Settings first.
  for (const sched of schedules) {
    const accountPlatform = ACCOUNT_PLATFORM_MAP[sched.platform] ?? sched.platform;
    if (!accountByPlatform.has(accountPlatform)) {
      throw new Error(
        `No connected ${sched.platform} account found for this brand. ` +
        `Connect the account in Settings before scheduling.`,
      );
    }
  }

  // YouTube requires a video asset — block scheduling if the variant only has
  // an image thumbnail (produced by fan-out, requiresVideo: true).  The user
  // must run convert_video on the YouTube variant first.
  // Uses ownedVariants already loaded above to avoid a second DB query.
  for (const sched of schedules) {
    if (sched.platform === "youtube") {
      const variant = ownedVariants.get(sched.variantId);
      if (!variant?.videoUrl && !variant?.mergedVideoUrl) {
        throw new Error(
          "YouTube variants require a video asset before scheduling. " +
          "Run convert_video on the YouTube card first, then schedule.",
        );
      }
    }
  }

  const entryIds: string[] = [];

  // Each row is inserted with publishStatus="scheduled" so the existing
  // publish-scheduler (pollAndPublish) will pick it up at the scheduled time
  // and dispatch through the platform-specific publish services.
  for (const sched of schedules) {
    const accountPlatform = ACCOUNT_PLATFORM_MAP[sched.platform] ?? sched.platform;
    const socialAccountId = accountByPlatform.get(accountPlatform) ?? null;
    const [entry] = await db
      .insert(calendarEntriesTable)
      .values({
        creativeId: creative.id,
        variantId: sched.variantId,
        platform: sched.platform,
        socialAccountId,
        scheduledAt: new Date(sched.scheduledAt),
        publishStatus: "scheduled",
        intent: creativeRow?.intent ?? null,
        scheduleMethod: "copilot",
      })
      .returning({ id: calendarEntriesTable.id });
    if (entry) entryIds.push(entry.id);
  }

  onProgress({ type: "progress", step: "schedule", message: `${entryIds.length} posts queued for publish scheduler`, done: true });

  const platformSet = new Set(schedules.map(s => s.platform));

  return {
    variantIds: schedules.map(s => s.variantId),
    costUsd: 0,
    summary:
      `${entryIds.length} post${entryIds.length !== 1 ? "s" : ""} scheduled across ` +
      `${platformSet.size} platform${platformSet.size !== 1 ? "s" : ""}`,
    metadata: { entryIds, schedules },
  };
}

/**
 * Co-pilot Studio sessions API.
 *
 * POST /api/sessions              — create a session (from brief or concept card)
 * GET  /api/sessions?brandId=     — continue rail (recent sessions for a brand)
 * GET  /api/sessions/:id          — session + turns + variant data
 * POST /api/sessions/:id/turns    — universal turn verb (SSE progress stream)
 * POST /api/sessions/:id/turns/:turnId/pick  — pick a compare take
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { str } from "../lib/http-params.js";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { generationLimiter } from "../lib/rate-limit.js";
import { requireAuth, requireEditorForWrites } from "../middleware/auth.js";
import { recordAudit, actorFromRequest } from "../lib/audit.js";
import {
  createSession,
  executeTurn,
  getSessionWithTurns,
  branchSession,
  type TurnAction,
} from "../services/session-service.js";
import {
  db,
  studioSessionsTable,
  sessionTurnsTable,
  creativesTable,
  creativeVariantsTable,
  costLogsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { estimateImagenCost, estimateClaudeCost, estimateGeminiTextCost, COST_ESTIMATES } from "../lib/ai-config.js";
import { reserveBudget, budgetExceededBody } from "../lib/budget.js";
import { recordTasteSignal } from "../services/taste-signals.js";
import { logger } from "../lib/logger.js";
import { PLATFORM_CONFIGS } from "../services/imagen.js";

const router: IRouter = Router();

const CreateSessionBody = z.object({
  brandId: z.string().min(1),
  briefText: z.string().min(1).max(2000),
  conceptId: z.string().optional(),
  intent: z.string().optional(),
  styleProfileId: z.string().optional(),
  personaId: z.string().optional(),
  selectedAssetIds: z.array(z.string()).optional(),
  existingCreativeId: z.string().optional(),
});

const RegionSchema = z.object({
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
});

const ScheduleItemSchema = z.object({
  variantId: z.string().min(1),
  platform: z.string().min(1),
  scheduledAt: z.string().datetime(),
});

// D3: Valid platform keys are derived from PLATFORM_CONFIGS (the source of
// truth in services/imagen.ts) so adding a platform there automatically makes
// it valid here; empty strings and unknown values are still rejected 400.
const VALID_PLATFORM_KEYS = Object.keys(PLATFORM_CONFIGS) as [string, ...string[]];

const CreateTurnBody = z.object({
  action: z.enum([
    "draft",
    "edit_image",
    "edit_region",
    "caption",
    "compare",
    "convert_video",
    "edit_video",
    "fan_out",
    "schedule",
  ]),
  instruction: z.string().min(0).max(2000).default(""),
  // D3: strict enum — rejects "" and unknown platform keys with 400.
  platform: z.enum(VALID_PLATFORM_KEYS).optional(),
  compareCount: z.number().int().min(2).max(5).optional(),
  region: RegionSchema.optional(),
  schedules: z.array(ScheduleItemSchema).max(10).optional(),
  // Optional: target a specific variant for convert_video (e.g. fan-out YouTube card)
  sourceVariantId: z.string().min(1).max(100).optional(),
});

const PickTakeBody = z.object({
  variantId: z.string().min(1),
});

router.post(
  "/sessions",
  requireAuth,
  requireEditorForWrites,
  validateRequest({ body: CreateSessionBody }),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof CreateSessionBody>;
    const actor = actorFromRequest(req);

    try {
      const session = await createSession({
        ...body,
        createdBy: actor.id,
      });

      await recordAudit({
        actor,
        action: "session.create",
        entityType: "studio_session",
        entityIds: [session.id],
        brandId: session.brandId,
        metadata: { briefText: body.briefText.slice(0, 200) },
      });

      res.status(201).json(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "Creative not found") {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg === "Creative does not belong to this brand") {
        res.status(400).json({ error: msg });
        return;
      }
      logger.error({ err }, "Failed to create session");
      res.status(500).json({ error: "Failed to create session" });
    }
  },
);

router.get(
  "/sessions",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : null;
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    if (!brandId) {
      res.status(400).json({ error: "brandId is required" });
      return;
    }

    const sessions = await db.select().from(studioSessionsTable)
      .where(eq(studioSessionsTable.brandId, brandId))
      .orderBy(desc(studioSessionsTable.updatedAt))
      .limit(limit);

    res.json({ sessions });
  },
);

router.get(
  "/sessions/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = str(req.params.id);
    const data = await getSessionWithTurns(id);
    if (!data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(data);
  },
);

router.post(
  "/sessions/:id/turns",
  requireAuth,
  requireEditorForWrites,
  generationLimiter,
  validateRequest({ body: CreateTurnBody }),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = str(req.params.id);
    const body = req.body as z.infer<typeof CreateTurnBody>;
    const actor = actorFromRequest(req);

    const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // D4: Fail fast when the direct Gemini key is missing — the Replit proxy
    // does not support the pinned model names and would return UNSUPPORTED_MODEL.
    if (!process.env["GEMINI_API_KEY"]) {
      res.status(503).json({
        error: "AI model access is not configured",
        message: "GEMINI_API_KEY is not set — Co-pilot Studio requires a direct Gemini API key to access the required models. Set the secret and restart.",
      });
      return;
    }

    // B1: Use the single shared reserveBudget helper (same lock key 100001 as
    // /generate and /video) so concurrent turns and legacy generations are all
    // serialized against the same daily-spend total.
    const estimatedCost = estimateTurnCost(body.action, body.compareCount);
    const budgetResult = await reserveBudget(session.creativeId, estimatedCost);
    if (!budgetResult.ok) {
      res.status(429).json(budgetExceededBody(budgetResult.todaySpend, budgetResult.threshold));
      return;
    }
    const reservationId = budgetResult.reservationId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // D1: AbortController wires client disconnect and SSE timeout into model calls
    // so hung interactions are cancelled and their reservation rows cleaned up.
    const turnAbort = new AbortController();

    const SSE_TIMEOUT_MS = 5 * 60 * 1000;
    let clientDisconnected = false;
    const sseTimeout = setTimeout(() => {
      if (!clientDisconnected) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Turn timed out after 5 minutes" })}\n\n`);
      }
      clientDisconnected = true;
      turnAbort.abort();
      res.end();
    }, SSE_TIMEOUT_MS);
    req.on("close", () => {
      clientDisconnected = true;
      clearTimeout(sseTimeout);
      // Abort the in-flight model call so the turn doesn't run to completion
      // billing the budget after the user has already navigated away.
      turnAbort.abort();
    });

    function sendEvent(event: string, data: Record<string, unknown>) {
      if (clientDisconnected) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      await executeTurn({
        sessionId,
        input: {
          action: body.action as TurnAction,
          instruction: body.instruction,
          platform: body.platform,
          compareCount: body.compareCount,
          region: body.region,
          schedules: body.schedules,
          sourceVariantId: body.sourceVariantId,
          signal: turnAbort.signal,
        },
        userId: actor.id,
        // B2: Pass reservationId so executeTurn can delete it atomically with
        // the real cost_logs insert, preventing phantom rows after a crash.
        reservationId: reservationId ?? undefined,
        onProgress: (event) => {
          sendEvent(event.type, { message: event.message, step: event.step, done: event.done, ...event.data });
        },
      });

      sendEvent("done", { sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sendEvent("error", { message: errMsg });
    } finally {
      // B2: Reservation is now settled atomically inside executeTurn's transaction
      // (on success) or released in executeTurn's error path.  No cleanup needed here.
      clearTimeout(sseTimeout);
      if (!clientDisconnected) res.end();
    }
  },
);

router.post(
  "/sessions/:id/turns/:turnId/pick",
  requireAuth,
  requireEditorForWrites,
  validateRequest({ body: PickTakeBody }),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = str(req.params.id);
    const turnId = str(req.params.turnId);
    const { variantId } = req.body as z.infer<typeof PickTakeBody>;
    const actor = actorFromRequest(req);

    const [session] = await db.select().from(studioSessionsTable).where(eq(studioSessionsTable.id, sessionId));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const [turn] = await db.select().from(sessionTurnsTable).where(
      and(eq(sessionTurnsTable.id, turnId), eq(sessionTurnsTable.sessionId, sessionId))
    );
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    const resultVariantIds = (turn.resultVariantIds || []) as string[];
    if (!resultVariantIds.includes(variantId)) {
      res.status(400).json({ error: "variantId does not belong to this turn's results" });
      return;
    }

    const passedOver = resultVariantIds.filter(id => id !== variantId);

    // For compare turns: restore the chosen take's imageInteractionId so subsequent
    // edit_image turns continue from the correct take's edit chain.
    let restoredInteractionId: string | null = null;
    if (turn.action === "compare" && turn.metadata) {
      const meta = turn.metadata as { perTakeVariantIds?: string[][]; perTakeInteractionIds?: string[] };
      const takeIndex = (meta.perTakeVariantIds || []).findIndex(ids => ids.includes(variantId));
      if (takeIndex >= 0 && meta.perTakeInteractionIds?.[takeIndex]) {
        restoredInteractionId = meta.perTakeInteractionIds[takeIndex];
      }
    }

    // C7: Derive thumbnail from the picked variant so the continue-rail stays
    // in sync. Prefer compositedImageUrl (final output) over rawImageUrl.
    const [pickedVariant] = await db
      .select({ compositedImageUrl: creativeVariantsTable.compositedImageUrl, rawImageUrl: creativeVariantsTable.rawImageUrl })
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.id, variantId));
    const newThumbnail = pickedVariant?.compositedImageUrl || pickedVariant?.rawImageUrl || null;

    const sessionUpdate: Record<string, unknown> = { activeVariantId: variantId, updatedAt: new Date() };
    if (restoredInteractionId) sessionUpdate.imageInteractionId = restoredInteractionId;
    if (newThumbnail) sessionUpdate.thumbnailUrl = newThumbnail;

    await db.update(studioSessionsTable).set(sessionUpdate).where(eq(studioSessionsTable.id, sessionId));

    const [creative] = await db.select().from(creativesTable).where(eq(creativesTable.id, session.creativeId));
    if (creative) {
      void recordTasteSignal({
        brandId: creative.brandId,
        creativeId: creative.id,
        variantId,
        signalType: "take_selected",
        payload: { source: "copilot_compare", turnId },
        userId: actor.id,
      });

      for (const pid of passedOver) {
        void recordTasteSignal({
          brandId: creative.brandId,
          creativeId: creative.id,
          variantId: pid,
          signalType: "take_passed_over",
          payload: { source: "copilot_compare", turnId },
          userId: actor.id,
        });
      }
    }

    res.json({ sessionId, activeVariantId: variantId });
  },
);

const BranchSessionBody = z.object({
  variantId: z.string().min(1),
});

router.post(
  "/sessions/:id/branch",
  requireAuth,
  requireEditorForWrites,
  validateRequest({ body: BranchSessionBody }),
  async (req: Request, res: Response): Promise<void> => {
    const sessionId = str(req.params.id);
    const { variantId } = req.body as z.infer<typeof BranchSessionBody>;
    const actor = actorFromRequest(req);

    try {
      const result = await branchSession({ sessionId, variantId });

      await recordAudit({
        actor,
        action: "session.branch",
        entityType: "studio_session",
        entityIds: [sessionId],
        brandId: null,
        metadata: { variantId, imageInteractionId: result.imageInteractionId },
      });

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId }, "Failed to branch session");
      res.status(err instanceof Error && err.message === "Session not found" ? 404 : 500).json({ error: msg });
    }
  },
);

// B3: Count of platform slots used by fan_out, derived from PLATFORM_CONFIGS
// so worst-case outpaint allowance tracks the real platform set.
const FAN_OUT_PLATFORM_COUNT = Object.keys(PLATFORM_CONFIGS).length;

// B4: Fixed video duration used for reservation (D2 pinned duration = 6s).
const VIDEO_RESERVATION_DURATION_S = 6;

function estimateTurnCost(action: string, compareCount?: number): number {
  switch (action) {
    case "draft":
      // B3: Include QA corrective-pass allowance (up to 1 extra image gen)
      return estimateImagenCost(1) + estimateClaudeCost() + estimateGeminiTextCost()
        + estimateImagenCost(1); // QA allowance
    case "edit_image":
    case "edit_region":
      // B3: Include QA corrective-pass allowance
      return estimateImagenCost(1) + estimateClaudeCost()
        + estimateImagenCost(1); // QA allowance
    case "caption":
      return estimateClaudeCost();
    case "compare":
      return (compareCount || 3) * (estimateImagenCost(1) + estimateClaudeCost());
    case "convert_video":
    case "edit_video":
      // B4: Reserve based on the pinned 6s duration so reservation == charge formula.
      return VIDEO_RESERVATION_DURATION_S * COST_ESTIMATES.VIDEO_COST_PER_SECOND_USD;
    case "fan_out":
      // B3: Worst-case all platforms outpaint (generative fill per aspect ratio)
      return estimateClaudeCost() + estimateGeminiTextCost()
        + estimateImagenCost(FAN_OUT_PLATFORM_COUNT); // outpaint allowance
    case "schedule":
      return 0;
    default:
      return estimateImagenCost(1);
  }
}

export default router;

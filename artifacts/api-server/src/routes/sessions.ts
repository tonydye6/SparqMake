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
  appSettingsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sql, gte } from "drizzle-orm";
import { estimateImagenCost, estimateClaudeCost, estimateGeminiTextCost, COST_ESTIMATES } from "../lib/ai-config.js";
import { recordTasteSignal } from "../services/taste-signals.js";
import { logger } from "../lib/logger.js";

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
  platform: z.string().optional(),
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

    const [thresholdRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "dailyCostThreshold"));
    const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;

    // reservationId is non-null only when we inserted a budget_reservation row
    // that must be cleaned up (deleted) after the turn completes or fails.
    let reservationId: string | null = null;

    if (budgetThreshold !== null && !isNaN(budgetThreshold) && budgetThreshold > 0) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const estimatedCost = estimateTurnCost(body.action, body.compareCount);
      const candidateId = crypto.randomUUID();

      const budgetCheckResult = await db.transaction(async (tx) => {
        const BUDGET_LOCK_KEY = 100002;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
        const [todayResult] = await tx.select({
          totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
        }).from(costLogsTable).where(gte(costLogsTable.createdAt, todayStart));
        const currentSpend = Number(todayResult?.totalCost || 0);

        if (currentSpend + estimatedCost > budgetThreshold) {
          return { exceeded: true as const, todaySpend: currentSpend };
        }

        await tx.insert(costLogsTable).values({
          id: candidateId,
          creativeId: session.creativeId,
          service: "system",
          operation: "budget_reservation",
          model: null,
          costUsd: estimatedCost,
        });
        return { exceeded: false as const, todaySpend: currentSpend };
      });

      if (budgetCheckResult.exceeded) {
        res.status(429).json({
          error: "Daily budget exceeded",
          todaySpend: budgetCheckResult.todaySpend,
          threshold: budgetThreshold,
        });
        return;
      }

      // Track the reservation so we can delete it once the turn finishes
      reservationId = candidateId;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const SSE_TIMEOUT_MS = 5 * 60 * 1000;
    let clientDisconnected = false;
    const sseTimeout = setTimeout(() => {
      if (!clientDisconnected) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Turn timed out after 5 minutes" })}\n\n`);
      }
      clientDisconnected = true;
      res.end();
    }, SSE_TIMEOUT_MS);
    req.on("close", () => { clientDisconnected = true; clearTimeout(sseTimeout); });

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
        },
        userId: actor.id,
        onProgress: (event) => {
          sendEvent(event.type, { message: event.message, step: event.step, done: event.done, ...event.data });
        },
      });

      sendEvent("done", { sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sendEvent("error", { message: errMsg });
    } finally {
      // Always reconcile the budget reservation: delete it so only the actual
      // cost row written by executeTurn counts toward the daily spend.
      if (reservationId) {
        db.delete(costLogsTable).where(eq(costLogsTable.id, reservationId)).catch((e: unknown) => {
          logger.error({ err: e, reservationId }, "Failed to delete budget reservation row");
        });
      }
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

    const sessionUpdate: Record<string, unknown> = { activeVariantId: variantId, updatedAt: new Date() };
    if (restoredInteractionId) sessionUpdate.imageInteractionId = restoredInteractionId;

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

function estimateTurnCost(action: string, compareCount?: number): number {
  switch (action) {
    case "draft":
      return estimateImagenCost(1) + estimateClaudeCost() + estimateGeminiTextCost();
    case "edit_image":
    case "edit_region":
      return estimateImagenCost(1) + estimateClaudeCost();
    case "caption":
      return estimateClaudeCost();
    case "compare":
      return (compareCount || 3) * (estimateImagenCost(1) + estimateClaudeCost());
    case "convert_video":
    case "edit_video":
      return COST_ESTIMATES.VIDEO_GENERATION_USD;
    case "fan_out":
      return estimateClaudeCost() + estimateGeminiTextCost();
    case "schedule":
      return 0;
    default:
      return estimateImagenCost(1);
  }
}

export default router;

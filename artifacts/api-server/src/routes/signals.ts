import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, or, isNull, lte, gte, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db, signalsTable } from "@workspace/db";
import { validateRequest } from "../middleware/validate.js";
import { PERFORMANCE_SIGNAL_SOURCE } from "../services/performance-insights.js";

// Generic signals ingestion API. Sources are registered here; the performance
// source is built in (its rows are written by the insights service). Future
// sources — in-game telemetry, current events, NCAA athlete news — register a
// new entry and POST signals without any schema change.
export const SIGNAL_SOURCES: Record<string, { label: string; description: string; managed: boolean }> = {
  [PERFORMANCE_SIGNAL_SOURCE]: {
    label: "Performance insights",
    description: "Derived from your own published-post engagement history.",
    managed: true, // written internally; not accepted via POST
  },
  telemetry: {
    label: "In-game telemetry",
    description: "Game events and player activity feeds (future).",
    managed: false,
  },
  news: {
    label: "Current events & athlete news",
    description: "External news and NCAA athlete updates (future).",
    managed: false,
  },
};

const router: IRouter = Router();

// GET /signal-sources — the registry, so clients can discover source types.
router.get("/signal-sources", (_req: Request, res: Response): void => {
  res.json({
    sources: Object.entries(SIGNAL_SOURCES).map(([type, meta]) => ({ type, ...meta })),
  });
});

// GET /signals — list signals, filterable by source/kind/brand; `active=true`
// restricts to signals whose relevance window covers now.
router.get("/signals", async (req: Request, res: Response): Promise<void> => {
  const { sourceType, kind, brandId, active } = req.query;
  const conditions = [];
  if (sourceType && typeof sourceType === "string") conditions.push(eq(signalsTable.sourceType, sourceType));
  if (kind && typeof kind === "string") conditions.push(eq(signalsTable.kind, kind));
  if (brandId && typeof brandId === "string") {
    conditions.push(or(eq(signalsTable.brandId, brandId), isNull(signalsTable.brandId))!);
  }
  if (active === "true") {
    const now = new Date();
    conditions.push(or(isNull(signalsTable.relevantFrom), lte(signalsTable.relevantFrom, now))!);
    conditions.push(or(isNull(signalsTable.relevantUntil), gte(signalsTable.relevantUntil, now))!);
  }

  const rows = await db.select().from(signalsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(signalsTable.updatedAt))
    .limit(200);
  res.json({ data: rows });
});

const IngestSignalBody = z.object({
  sourceType: z.string().min(1).max(64),
  kind: z.string().min(1).max(64),
  brandId: z.string().min(1).optional(),
  title: z.string().min(1).max(500),
  payload: z.record(z.string(), z.unknown()),
  strength: z.number().min(0).max(1).optional(),
  relevantFrom: z.string().datetime().optional(),
  relevantUntil: z.string().datetime().optional(),
  dedupeKey: z.string().min(1).max(200).optional(),
});

// POST /signals — ingest a signal from a registered (non-managed) source.
// Upserts when a dedupeKey is provided, so sources can refresh in place.
router.post(
  "/signals",
  validateRequest({ body: IngestSignalBody }),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof IngestSignalBody>;

    const source = SIGNAL_SOURCES[body.sourceType];
    if (!source) {
      res.status(400).json({
        error: `Unknown signal source "${body.sourceType}". Registered sources: ${Object.keys(SIGNAL_SOURCES).join(", ")}`,
      });
      return;
    }
    if (source.managed) {
      res.status(400).json({ error: `Source "${body.sourceType}" is managed internally and does not accept ingestion.` });
      return;
    }

    const now = new Date();
    const values = {
      sourceType: body.sourceType,
      kind: body.kind,
      brandId: body.brandId ?? null,
      title: body.title,
      payload: body.payload,
      strength: body.strength ?? null,
      relevantFrom: body.relevantFrom ? new Date(body.relevantFrom) : null,
      relevantUntil: body.relevantUntil ? new Date(body.relevantUntil) : null,
      dedupeKey: body.dedupeKey ?? null,
      updatedAt: now,
    };

    if (body.dedupeKey) {
      const [row] = await db.insert(signalsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [signalsTable.sourceType, signalsTable.dedupeKey],
          set: { ...values, sourceType: sql`excluded.source_type` },
        })
        .returning();
      res.status(201).json(row);
      return;
    }

    const [row] = await db.insert(signalsTable).values(values).returning();
    res.status(201).json(row);
  },
);

export default router;

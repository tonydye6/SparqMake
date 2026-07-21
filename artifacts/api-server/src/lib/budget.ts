/**
 * B1: Shared budget reservation helper — single source of truth for the
 * advisory-lock-based daily-spend gate used across all generation routes
 * (sessions, generate, video).  Callers use the same lock key (100001) and
 * the same cost_logs SUM, so concurrent turn + /generate requests are fully
 * serialized against the same limit.
 */

import { db, costLogsTable, appSettingsTable } from "@workspace/db";
import { eq, sql, gte } from "drizzle-orm";

const BUDGET_LOCK_KEY = 100001;

export type BudgetResult =
  | { ok: true; reservationId: string | null }
  | { ok: false; todaySpend: number; threshold: number };

/**
 * Attempt to reserve `estimatedCost` against today's daily budget.
 *
 * - If no threshold is configured, returns `{ ok: true, reservationId: null }` (no-op).
 * - If the reservation would exceed the threshold, returns `{ ok: false }`.
 * - On success, inserts a `budget_reservation` cost_logs row and returns its id.
 *   The caller MUST settle the reservation (delete the row) in the same
 *   transaction as the real cost_logs row, or eagerly on the error path, to
 *   prevent phantom rows from accumulating.
 */
export async function reserveBudget(
  creativeId: string,
  estimatedCost: number,
): Promise<BudgetResult> {
  const [thresholdRow] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, "dailyCostThreshold"));
  const budgetThreshold = thresholdRow ? parseFloat(thresholdRow.value) : null;
  if (budgetThreshold === null || isNaN(budgetThreshold) || budgetThreshold <= 0) {
    return { ok: true, reservationId: null };
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const reservationId = crypto.randomUUID();

  const result = await db.transaction(async (tx) => {
    // Serialize all budget checks under the same advisory lock so a concurrent
    // copilot turn + /generate cannot jointly exceed the daily threshold.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const [todayResult] = await tx
      .select({ totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)` })
      .from(costLogsTable)
      .where(gte(costLogsTable.createdAt, todayStart));
    const currentSpend = Number(todayResult?.totalCost || 0);
    if (currentSpend + estimatedCost > budgetThreshold) {
      return { exceeded: true as const, todaySpend: currentSpend };
    }
    await tx.insert(costLogsTable).values({
      id: reservationId,
      creativeId,
      service: "system",
      operation: "budget_reservation",
      model: null,
      costUsd: estimatedCost,
    });
    return { exceeded: false as const, todaySpend: currentSpend };
  });

  if (result.exceeded) {
    return { ok: false, todaySpend: result.todaySpend, threshold: budgetThreshold };
  }
  return { ok: true, reservationId };
}

/**
 * Standard 429 response body returned when the daily budget is exceeded.
 * All callers must use this helper so the `message` key is always present
 * (the SSE client in CopilotStudio surfaces it on a generic error toast).
 */
export function budgetExceededBody(todaySpend: number, threshold: number) {
  return {
    error: "Daily budget exceeded",
    todaySpend,
    threshold,
    message:
      `Today's spend ($${todaySpend.toFixed(2)}) has reached the daily budget limit ` +
      `($${threshold.toFixed(2)}). Increase the limit in Cost Dashboard settings or wait until tomorrow.`,
  };
}

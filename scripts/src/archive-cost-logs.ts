/**
 * Cost-log retention / archival job.
 *
 * The `cost_logs` table grows on every Claude / Imagen / ElevenLabs call and has
 * no built-in retention policy, so it would otherwise grow forever. This job
 * keeps the live table lean while preserving lifetime totals:
 *
 *   1. Determine a retention window (COST_LOG_RETENTION_DAYS, default 90 days).
 *   2. Roll up every whole calendar month that is entirely older than the window
 *      into `cost_log_monthly_summary` (one row per month/service/operation).
 *   3. Delete the raw rows that were rolled up.
 *
 * Archival is whole-month aligned: only months strictly before the month that
 * contains the cutoff are archived. This guarantees `cost_logs` and
 * `cost_log_monthly_summary` never cover the same month, so the analytics
 * endpoint can combine them without double counting. As a result the live table
 * retains between the configured window and roughly one extra month of raw rows.
 *
 * Idempotent: rolled-up rows are deleted in the same transaction they are
 * aggregated in, and the upsert into the summary table is additive, so running
 * the job repeatedly (or after the window changes) never double counts.
 *
 * Run with: `pnpm --filter @workspace/scripts archive-cost-logs`
 * Schedule this (e.g. a daily Replit Scheduled Deployment) to keep the table small.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const DEFAULT_RETENTION_DAYS = 90;

function getRetentionDays(): number {
  const raw = process.env.COST_LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid COST_LOG_RETENTION_DAYS="${raw}". Must be a positive number of days.`,
    );
  }
  return Math.floor(parsed);
}

/** First day (00:00:00 UTC) of the calendar month containing `date`. */
function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

async function main(): Promise<void> {
  const retentionDays = getRetentionDays();

  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  // Only archive whole months strictly before the cutoff's month. Rows in the
  // cutoff's own month (and newer) stay in cost_logs so we never split a month.
  const archiveBefore = startOfMonthUtc(cutoff);

  console.log(
    `[archive-cost-logs] retention=${retentionDays}d; archiving cost_logs rows older than ${archiveBefore.toISOString()} (whole months only)`,
  );

  const result = await db.transaction(async (tx) => {
    // Roll up the archivable rows into the monthly summary table. date_trunc
    // gives the first-of-month timestamp used as the summary `month` key.
    const upserted = await tx.execute(sql`
      INSERT INTO cost_log_monthly_summary
        (id, month, service, operation, total_cost_usd, entry_count, input_tokens, output_tokens, created_at, updated_at)
      SELECT
        gen_random_uuid()::text,
        date_trunc('month', created_at) AS month,
        service,
        operation,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS entry_count,
        -- Cast through text so this works whether the source columns are
        -- integer (current schema) or text (legacy/drifted databases).
        SUM(NULLIF(input_tokens::text, '')::integer) AS input_tokens,
        SUM(NULLIF(output_tokens::text, '')::integer) AS output_tokens,
        now(),
        now()
      FROM cost_logs
      WHERE created_at < ${archiveBefore}
      GROUP BY date_trunc('month', created_at), service, operation
      ON CONFLICT (month, service, operation) DO UPDATE SET
        total_cost_usd = cost_log_monthly_summary.total_cost_usd + EXCLUDED.total_cost_usd,
        entry_count    = cost_log_monthly_summary.entry_count + EXCLUDED.entry_count,
        input_tokens   = COALESCE(cost_log_monthly_summary.input_tokens, 0) + COALESCE(EXCLUDED.input_tokens, 0),
        output_tokens  = COALESCE(cost_log_monthly_summary.output_tokens, 0) + COALESCE(EXCLUDED.output_tokens, 0),
        updated_at     = now()
    `);

    // Delete exactly the rows we just rolled up. Within this transaction no new
    // row older than archiveBefore can appear (created_at defaults to now()),
    // so the same predicate is safe and equivalent to "the rows we aggregated".
    const deleted = await tx.execute(sql`
      DELETE FROM cost_logs WHERE created_at < ${archiveBefore}
    `);

    return {
      summaryRowsAffected: upserted.rowCount ?? 0,
      rawRowsDeleted: deleted.rowCount ?? 0,
    };
  });

  console.log(
    `[archive-cost-logs] done: archived ${result.rawRowsDeleted} raw rows into ${result.summaryRowsAffected} monthly summary buckets`,
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[archive-cost-logs] failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });

import type { Request } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Audit logging for privileged & destructive mutations.
 * -----------------------------------------------------
 * `recordAudit` writes a durable row describing who did what to which entity.
 *
 * Ordering / consistency contract:
 *  - Callers MUST invoke `recordAudit` only AFTER the primary mutation has
 *    succeeded (e.g. after the `.delete(...).returning()` resolves). This way a
 *    record is only ever written for an action that actually happened — the log
 *    never claims a delete that was rolled back or errored.
 *  - `recordAudit` never throws. A failure to write the audit row is caught and
 *    logged at `error` level (so the gap is loud and discoverable) but is not
 *    propagated, so a logging failure can never break or undo the user's
 *    destructive operation. This trades strict atomicity for guaranteeing the
 *    primary operation is never harmed by audit infrastructure.
 *  - For the rare case where a caller needs the audit insert to commit or roll
 *    back atomically with the mutation, pass the active transaction handle as
 *    `tx`; the insert then participates in that transaction.
 */

export interface AuditActor {
  id: string;
  role: string;
}

export interface RecordAuditParams {
  /** Who performed the action. Usually derived via `actorFromRequest`. */
  actor: AuditActor;
  /** Namespaced verb, e.g. "asset.bulk_delete", "brand.archive", "user.role_change". */
  action: string;
  /** Entity kind the action targeted, e.g. "asset", "brand", "social_account", "setting", "user". */
  entityType: string;
  /** Affected id(s). For bulk operations this holds every affected id. */
  entityIds?: string[];
  /** Number of rows affected. Defaults to `entityIds.length` when omitted. */
  affectedCount?: number;
  /** Tenancy seam for future per-brand scoping. Nullable. */
  brandId?: string | null;
  /** Extra context to reconstruct what happened (changed keys, prior/next values, etc.). */
  metadata?: Record<string, unknown>;
  /**
   * Optional Drizzle transaction/db handle. Pass this to make the audit insert
   * commit/roll back atomically with the primary mutation. Defaults to the
   * shared `db` (audit written after the mutation, non-atomically).
   */
  tx?: Pick<typeof db, "insert">;
}

const UNKNOWN_ACTOR: AuditActor = { id: "unknown", role: "unknown" };

/** Extract the acting user from an authenticated request, with safe fallbacks. */
export function actorFromRequest(req: Request): AuditActor {
  const user = (req as unknown as { user?: { id?: unknown; role?: unknown } }).user;
  if (!user || typeof user.id !== "string") return UNKNOWN_ACTOR;
  return {
    id: user.id,
    role: typeof user.role === "string" ? user.role : "unknown",
  };
}

/**
 * Write a durable audit record. Never throws — see the contract above.
 * Returns `true` on success and `false` if the write failed (already logged).
 */
export async function recordAudit(params: RecordAuditParams): Promise<boolean> {
  const {
    actor,
    action,
    entityType,
    entityIds,
    affectedCount,
    brandId = null,
    metadata,
    tx,
  } = params;

  const count = affectedCount ?? entityIds?.length ?? null;

  try {
    await (tx ?? db).insert(auditLogsTable).values({
      actorId: actor.id,
      actorRole: actor.role,
      action,
      entityType,
      entityIds: entityIds ?? null,
      affectedCount: count,
      brandId,
      metadata: metadata ?? null,
    });
    return true;
  } catch (err) {
    logger.error(
      { err, action, entityType, actorId: actor.id, affectedCount: count },
      "Failed to write audit log — the primary operation was NOT affected",
    );
    return false;
  }
}

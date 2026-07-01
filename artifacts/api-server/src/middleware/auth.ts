import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, or, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const DEV_USER = {
  id: "dev-user-00000000-0000-0000-0000-000000000000",
  email: "dev@sparqmake.local",
  name: "Dev User",
  image: null,
  role: "editor",
};

// Every email the dev-bypass account has ever been created with. The account is
// only ever inserted (never updated), so an old build's email can persist in the
// DB after a rename (e.g. the legacy `sparqforge.local` domain). Cleanup must
// match every historical identity so a drifted record is still removed. These
// literals are reserved for the dev bypass and can never belong to a real user.
const DEV_BYPASS_EMAILS = ["dev@sparqmake.local", "dev@sparqforge.local"];

let devUserEnsured = false;

async function ensureDevUser() {
  if (devUserEnsured) return;
  try {
    const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, DEV_USER.id));
    if (!existing) {
      await db.insert(usersTable).values({
        id: DEV_USER.id,
        email: DEV_USER.email,
        name: DEV_USER.name,
        image: DEV_USER.image,
        role: DEV_USER.role,
      });
      logger.info("Dev bypass user created");
    }
    devUserEnsured = true;
  } catch (err) {
    logger.error(err, "Failed to ensure dev user");
  }
}

function isDeployedEnvironment(): boolean {
  // `REPLIT_DEPLOYMENT` is injected by the platform at deploy time and cannot be
  // set from project env config, so it is a trustworthy production signal.
  // `NODE_ENV` is included as a secondary signal for non-Replit/local prod runs.
  return !!process.env.REPLIT_DEPLOYMENT || process.env.NODE_ENV === "production";
}

let prodFlagWarned = false;

export function isDevBypass(): boolean {
  if (process.env.DEV_AUTH_BYPASS !== "true") return false;
  if (isDeployedEnvironment()) {
    // Defense-in-depth: never honor the bypass in a deployed environment, even
    // if the flag leaks in. Warn once instead of erroring per-request so a
    // misconfiguration cannot flood the logs.
    if (!prodFlagWarned) {
      prodFlagWarned = true;
      logger.warn(
        "DEV_AUTH_BYPASS=true detected in a deployed environment — ignoring it. Authentication is NOT bypassed. Remove this flag from the production environment.",
      );
    }
    return false;
  }
  return true;
}

if (isDevBypass()) {
  logger.warn("⚠️  STARTUP WARNING: DEV_AUTH_BYPASS=true — authentication is bypassed. Do NOT deploy with this setting.");
}

/**
 * Remove the dev-bypass account from the database when the bypass is disabled
 * (as it always is in a deployed/production environment).
 *
 * This must be invoked explicitly during startup (see index.ts) rather than run
 * as an import side-effect: a side-effect is invisible, unawaited, and its
 * errors were previously swallowed, so a failure left the stray account in place
 * with no signal. Running it from the controlled bootstrap makes the outcome
 * logged and ordered before the server accepts requests.
 *
 * Deletion is scoped strictly to the reserved dev-bypass identity — its fixed id
 * OR any of its historical emails — so it can never touch a legitimate user, and
 * still removes a record whose email drifted across a rename.
 */
export async function cleanupDevBypassUser(): Promise<void> {
  if (isDevBypass()) return;
  try {
    const rows = await db
      .delete(usersTable)
      .where(
        or(
          eq(usersTable.id, DEV_USER.id),
          inArray(usersTable.email, DEV_BYPASS_EMAILS),
        ),
      )
      .returning();
    if (rows.length > 0) {
      logger.info({ count: rows.length }, "Cleaned up dev bypass user(s) from database");
    }
  } catch (err) {
    logger.error(err, "Failed to clean up dev bypass user");
  }
}

export function isGoogleConfigured(): boolean {
  return !!(
    (process.env.SparqMake_Google_Client_ID || process.env.GOOGLE_CLIENT_ID) &&
    (process.env.SparqMake_Google_Client_Secret || process.env.GOOGLE_CLIENT_SECRET)
  );
}

let devBypassWarningLogged = false;

export function devBypassMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!isDevBypass()) {
    next();
    return;
  }

  if (!devBypassWarningLogged) {
    logger.warn("⚠️  DEV_AUTH_BYPASS is active — all requests bypass authentication. Do NOT use in production.");
    devBypassWarningLogged = true;
  }

  ensureDevUser().then(() => {
    (req as any).user = DEV_USER;
    next();
  }).catch(next);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isDevBypass()) {
    next();
    return;
  }

  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    next();
    return;
  }

  res.status(401).json({ error: "Authentication required" });
}

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };

export type AppRole = "viewer" | "editor" | "admin";

export function requireRole(min: AppRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req.user as Express.User | undefined)?.role ?? "viewer";
    if ((ROLE_RANK[role] ?? 0) >= ROLE_RANK[min]) {
      next();
      return;
    }
    res.status(403).json({ error: "Insufficient permissions" });
  };
}

export function requireEditorForWrites(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  requireRole("editor")(req, res, next);
}

/**
 * Mutation authorization policy
 * -----------------------------
 * Single source of truth for the role required by each *class* of mutation.
 * Route handlers must attach one of the exported guards below instead of
 * calling `requireRole(...)` ad-hoc, so the policy is defined in exactly one
 * place and stays consistent across routes.
 *
 * Classes:
 *  - standardWrite: routine single-resource create/update. Requires `editor`.
 *                   This matches the blanket `requireEditorForWrites` baseline;
 *                   attach it explicitly only where a route needs to be self
 *                   documenting.
 *  - bulk:          operations that mutate many rows in one call (bulk-delete,
 *                   bulk-update). Requires `admin` — a single call can affect
 *                   the entire library, so it is gated above base editor.
 *  - destructive:   permanent single-resource deletes / archives. Requires
 *                   `admin`. Applied to every hard-delete endpoint so deleting
 *                   is uniformly gated regardless of resource type.
 *
 * Coherence note: a resource whose *edit* stays at `editor` while its *delete*
 * requires `admin` is intentional when edits are reversible (e.g. templates are
 * version-snapshotted and can be rolled back) but deletes are permanent.
 *
 * Tenancy seam: `requireMutation` is the single choke point for the check. To
 * later add per-brand / per-user ownership isolation, resolve the target
 * resource's owner inside this factory and combine it with the role check — no
 * route call site needs to change. Intentionally not implemented now (product
 * deferral); this comment marks the extension point.
 */
export type MutationClass = "standardWrite" | "bulk" | "destructive";

export const MUTATION_POLICY: Record<MutationClass, AppRole> = {
  standardWrite: "editor",
  bulk: "admin",
  destructive: "admin",
};

export function requireMutation(mutationClass: MutationClass) {
  // Extension point for tenancy isolation — see the block comment above.
  return requireRole(MUTATION_POLICY[mutationClass]);
}

// Stable guard singletons. Routes share these references so the policy is
// applied uniformly and wiring can be asserted by identity in tests.
export const requireStandardWrite = requireMutation("standardWrite");
export const requireBulkMutation = requireMutation("bulk");
export const requireDestructive = requireMutation("destructive");

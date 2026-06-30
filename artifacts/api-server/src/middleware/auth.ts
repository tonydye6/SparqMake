import type { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const DEV_USER = {
  id: "dev-user-00000000-0000-0000-0000-000000000000",
  email: "dev@sparqmake.local",
  name: "Dev User",
  image: null,
  role: "editor",
};

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
} else {
  db.delete(usersTable)
    .where(eq(usersTable.id, DEV_USER.id))
    .returning()
    .then((rows) => {
      if (rows.length > 0) {
        logger.info("Cleaned up dev bypass user from database");
      }
    })
    .catch(() => {});
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

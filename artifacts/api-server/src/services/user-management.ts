import { db, usersTable } from "@workspace/db";
import { and, count, eq, ne } from "drizzle-orm";

/**
 * Pragmatic email check for admin-entered invites. This is intentionally
 * lenient (single `@`, non-empty local/domain parts, a dotted domain) — the
 * authoritative gate on who can actually sign in is the OAuth allow-list in
 * lib/passport.ts, not this format check.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

/** Postgres unique-violation SQLSTATE, raised if a duplicate slips past the pre-check (race). */
const PG_UNIQUE_VIOLATION = "23505";

/** Postgres foreign-key-violation SQLSTATE, raised when deleting a user whose id is still referenced (onDelete: restrict). */
const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Extract the Postgres SQLSTATE from a thrown error. Drizzle wraps driver
 * errors (DrizzleQueryError with the original error on `cause`), so the code
 * may live on the error itself or one level down.
 */
function pgErrorCode(err: unknown): string | undefined {
  const direct = (err as { code?: unknown })?.code;
  if (typeof direct === "string") return direct;
  const nested = (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof nested === "string" ? nested : undefined;
}

/**
 * Roles must match the `users_role_check` DB constraint in lib/db/src/schema/users.ts.
 * Keep this list in sync with that constraint and with the ROLE_RANK in middleware/auth.ts.
 */
export const APP_ROLES = ["viewer", "editor", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isValidRole(role: unknown): role is AppRole {
  return typeof role === "string" && (APP_ROLES as readonly string[]).includes(role);
}

export interface ManagedUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  updatedAt: Date;
}

const userColumns = {
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  role: usersTable.role,
  updatedAt: usersTable.updatedAt,
};

export type UserManagementErrorCode =
  | "not_found"
  | "invalid_role"
  | "last_admin"
  | "invalid_email"
  | "duplicate_email"
  | "has_content";

export class UserManagementError extends Error {
  constructor(
    public readonly code: UserManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserManagementError";
  }
}

export async function listUsers(): Promise<ManagedUser[]> {
  return db.select(userColumns).from(usersTable).orderBy(usersTable.email);
}

/**
 * Change a single user's role.
 *
 * Guards:
 *  - the new role must be one of APP_ROLES (matches the DB check constraint);
 *  - the target user must exist;
 *  - demoting the *last* remaining admin is rejected, so an admin can never
 *    lock every admin (including themselves) out of user management.
 */
export async function updateUserRole(id: string, role: unknown): Promise<ManagedUser> {
  if (!isValidRole(role)) {
    throw new UserManagementError("invalid_role", "Invalid role");
  }

  const [target] = await db.select(userColumns).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    throw new UserManagementError("not_found", "User not found");
  }

  const isDemotingAnAdmin = target.role === "admin" && role !== "admin";
  if (isDemotingAnAdmin) {
    const [{ value: otherAdmins }] = await db
      .select({ value: count() })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), ne(usersTable.id, id)));
    if (Number(otherAdmins) === 0) {
      throw new UserManagementError(
        "last_admin",
        "Cannot change the role of the last remaining admin",
      );
    }
  }

  const [updated] = await db
    .update(usersTable)
    .set({ role, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning(userColumns);

  return updated;
}

/**
 * Delete a workspace user, or revoke a pending invite (a row created by
 * inviteUser that has never signed in — same table, `name` still null).
 *
 * Guards:
 *  - the target user must exist;
 *  - deleting the *last* remaining admin is rejected, mirroring the
 *    last-admin guard in updateUserRole, so user management can never be
 *    orphaned;
 *  - if the user's id is still referenced by content they created
 *    (creatives.created_by / refinement_logs.user_id use onDelete: restrict),
 *    the FK violation is surfaced as `has_content` instead of a raw DB error.
 *    Pending invites can never trip this — they have no content.
 */
export async function deleteUser(id: string): Promise<ManagedUser> {
  const [target] = await db.select(userColumns).from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    throw new UserManagementError("not_found", "User not found");
  }

  if (target.role === "admin") {
    const [{ value: otherAdmins }] = await db
      .select({ value: count() })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), ne(usersTable.id, id)));
    if (Number(otherAdmins) === 0) {
      throw new UserManagementError("last_admin", "Cannot remove the last remaining admin");
    }
  }

  try {
    const [deleted] = await db.delete(usersTable).where(eq(usersTable.id, id)).returning(userColumns);
    if (!deleted) {
      throw new UserManagementError("not_found", "User not found");
    }
    return deleted;
  } catch (err) {
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw new UserManagementError(
        "has_content",
        "This user has created content in the workspace and can't be removed. Change their role to Viewer instead to revoke write access.",
      );
    }
    throw err;
  }
}

/**
 * Invite (pre-create) a workspace user so an admin can onboard a teammate
 * before that person has ever signed in.
 *
 * The record is inserted with `name = null`; the real display name is filled in
 * on first Google sign-in (see lib/passport.ts, which matches by email and, for
 * an existing row, updates name/image while preserving the pre-assigned role).
 * That is how an invited user "lands with the assigned role" — the role set here
 * is not overwritten at login.
 *
 * Guards:
 *  - the role must be one of APP_ROLES (matches the DB check constraint);
 *  - the email must be a plausible address (normalized to lowercase/trimmed);
 *  - the email must not already belong to a user (duplicate_email). A unique
 *    constraint on the column is the final backstop for a concurrent insert.
 */
export async function inviteUser(email: unknown, role: unknown): Promise<ManagedUser> {
  if (!isValidRole(role)) {
    throw new UserManagementError("invalid_role", "Invalid role");
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new UserManagementError("invalid_email", "Enter a valid email address");
  }

  const [existing] = await db
    .select(userColumns)
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);
  if (existing) {
    throw new UserManagementError("duplicate_email", "A user with this email already exists");
  }

  try {
    const [created] = await db
      .insert(usersTable)
      .values({ email: normalizedEmail, name: null, role })
      .returning(userColumns);
    return created;
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new UserManagementError("duplicate_email", "A user with this email already exists");
    }
    throw err;
  }
}

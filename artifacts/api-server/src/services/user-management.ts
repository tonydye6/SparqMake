import { db, usersTable } from "@workspace/db";
import { and, count, eq, ne } from "drizzle-orm";

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
}

const userColumns = {
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  role: usersTable.role,
};

export type UserManagementErrorCode = "not_found" | "invalid_role" | "last_admin";

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

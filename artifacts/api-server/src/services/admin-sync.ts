import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
import { inviteUser, UserManagementError } from "./user-management";

/**
 * Startup admin sync driven by the ADMIN_EMAILS env var.
 * ------------------------------------------------------
 * Makes ADMIN_EMAILS authoritative for GRANTING admin access at server start:
 *  - an existing user listed in ADMIN_EMAILS is promoted to admin;
 *  - a listed email with no user row gets a pending admin invite row
 *    (via the same inviteUser logic the User Management UI uses), so the
 *    person can sign in with Google and land as admin on first sign-in.
 *
 * Promotions only — this NEVER demotes or deletes. Removing an email from
 * ADMIN_EMAILS later has no effect on that user; demotions remain a
 * deliberate act in the User Management UI (protected by the last-admin
 * guard there).
 *
 * Idempotent by construction: an already-admin user is a no-op, and an
 * existing row (user or pending invite) is never re-inserted. Malformed
 * entries are skipped with a warning; any per-email failure is logged and
 * the rest of the list still processes. The function never throws, so a
 * problem here can never prevent server startup.
 *
 * The env var is read at call time (not module load) so tests and restarts
 * always see the current value. Emails are matched case-insensitively and
 * stored lowercased, consistent with the invite flow.
 */

const SYSTEM_ACTOR = { id: "system", role: "system" } as const;

function parseAdminEmails(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      (raw || "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export async function syncAdminEmails(): Promise<void> {
  const emails = parseAdminEmails(process.env.ADMIN_EMAILS);
  if (emails.length === 0) {
    logger.info("ADMIN_EMAILS is unset or empty — skipping startup admin sync");
    return;
  }

  let promoted = 0;
  let invited = 0;
  let alreadyAdmin = 0;
  let skipped = 0;

  for (const email of emails) {
    try {
      // Case-insensitive lookup: historical rows may have been stored with
      // mixed-case emails, and Postgres text equality is case-sensitive.
      const matches = await db
        .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${email}`)
        .limit(2);
      if (matches.length > 1) {
        // Legacy data anomaly: multiple rows differ only by email casing.
        // Promote deterministically (first match) and make the anomaly loud.
        logger.warn(
          { email, count: matches.length },
          "Startup admin sync: multiple user rows match this email case-insensitively — promoting the first; clean up duplicates in User Management",
        );
      }
      const existing = matches[0];

      if (existing) {
        if (existing.role === "admin") {
          alreadyAdmin++;
          continue;
        }
        // Promotion only — the WHERE clause targets this one row and the
        // update sets admin unconditionally; no path here ever lowers a role.
        const [updated] = await db
          .update(usersTable)
          .set({ role: "admin", updatedAt: new Date() })
          .where(eq(usersTable.id, existing.id))
          .returning({ id: usersTable.id });
        if (updated) {
          promoted++;
          logger.info({ email }, "Startup admin sync: promoted existing user to admin");
          await recordAudit({
            actor: SYSTEM_ACTOR,
            action: "user.admin_sync_promote",
            entityType: "user",
            entityIds: [existing.id],
            metadata: { email, previousRole: existing.role, newRole: "admin", source: "ADMIN_EMAILS" },
          });
        }
        continue;
      }

      const created = await inviteUser(email, "admin");
      invited++;
      logger.info({ email }, "Startup admin sync: created pending admin invite");
      await recordAudit({
        actor: SYSTEM_ACTOR,
        action: "user.admin_sync_invite",
        entityType: "user",
        entityIds: [created.id],
        metadata: { email, role: "admin", source: "ADMIN_EMAILS" },
      });
    } catch (err) {
      if (err instanceof UserManagementError && err.code === "invalid_email") {
        skipped++;
        logger.warn({ email }, "Startup admin sync: skipping malformed ADMIN_EMAILS entry");
        continue;
      }
      if (err instanceof UserManagementError && err.code === "duplicate_email") {
        // Lost a race with a concurrent insert (e.g. the person signed in at
        // this exact moment). The row now exists; the next restart will
        // promote it if needed.
        skipped++;
        logger.warn({ email }, "Startup admin sync: row appeared concurrently — will reconcile on next start");
        continue;
      }
      skipped++;
      logger.error({ err, email }, "Startup admin sync: failed to process email — continuing with the rest");
    }
  }

  logger.info(
    { promoted, invited, alreadyAdmin, skipped, total: emails.length },
    "Startup admin sync complete",
  );
}

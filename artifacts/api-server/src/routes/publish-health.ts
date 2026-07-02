import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  calendarEntriesTable,
  creativesTable,
  socialAccountsTable,
  publishAlertsTable,
} from "@workspace/db";
import { MAX_RETRIES } from "../services/publish-constants";
import { isEmailConfigured } from "../services/email";

const router: IRouter = Router();

/**
 * Publish health summary: every currently-failed scheduled publish (with its
 * human-readable reason and whether the scheduler will still retry it) plus
 * the recent alert-delivery history. Read-only; retrying is a separate,
 * write-gated action (POST /calendar-entries/:id/retry).
 */
router.get("/publish-health", async (_req, res): Promise<void> => {
  const failures = await db
    .select({
      id: calendarEntriesTable.id,
      creativeId: calendarEntriesTable.creativeId,
      platform: calendarEntriesTable.platform,
      scheduledAt: calendarEntriesTable.scheduledAt,
      publishError: calendarEntriesTable.publishError,
      retryCount: calendarEntriesTable.retryCount,
      socialAccountId: calendarEntriesTable.socialAccountId,
      alertedAt: calendarEntriesTable.alertedAt,
      updatedAt: calendarEntriesTable.updatedAt,
      creativeName: creativesTable.name,
      accountName: socialAccountsTable.accountName,
    })
    .from(calendarEntriesTable)
    .innerJoin(creativesTable, eq(calendarEntriesTable.creativeId, creativesTable.id))
    .leftJoin(socialAccountsTable, eq(calendarEntriesTable.socialAccountId, socialAccountsTable.id))
    .where(eq(calendarEntriesTable.publishStatus, "failed"))
    .orderBy(desc(calendarEntriesTable.updatedAt))
    .limit(50);

  const shaped = failures.map((f) => ({
    ...f,
    permanent: (f.retryCount ?? 0) >= MAX_RETRIES || !f.socialAccountId,
  }));

  const alerts = await db
    .select({
      id: publishAlertsTable.id,
      socialAccountId: publishAlertsTable.socialAccountId,
      entryCount: publishAlertsTable.entryCount,
      channel: publishAlertsTable.channel,
      recipientCount: publishAlertsTable.recipientCount,
      status: publishAlertsTable.status,
      summary: publishAlertsTable.summary,
      sentAt: publishAlertsTable.sentAt,
      accountName: socialAccountsTable.accountName,
    })
    .from(publishAlertsTable)
    .leftJoin(socialAccountsTable, eq(publishAlertsTable.socialAccountId, socialAccountsTable.id))
    .orderBy(desc(publishAlertsTable.sentAt))
    .limit(10);

  res.json({
    failedCount: shaped.length,
    permanentCount: shaped.filter((f) => f.permanent).length,
    failures: shaped,
    alerts,
    emailConfigured: isEmailConfigured(),
  });
});

export default router;

import { eq, and, or, isNull, gte, desc, inArray } from "drizzle-orm";
import {
  db,
  calendarEntriesTable,
  creativesTable,
  socialAccountsTable,
  publishAlertsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { recordAudit } from "../lib/audit";
import { isEmailConfigured, sendEmail } from "./email";
import { MAX_RETRIES } from "./publish-constants";

/**
 * Proactive alerting for permanently failed scheduled publishes.
 * --------------------------------------------------------------
 * The publish scheduler calls `sweepPublishFailureAlerts()` on every poll.
 * The sweep finds failed calendar entries the scheduler will never retry on
 * its own (retries exhausted, or no social account connected) that have not
 * been alerted yet, groups them per social account, and delivers one grouped
 * notification per account — so a broken token doesn't spam admins with one
 * email per post.
 *
 * Cooldown: after any delivery attempt (sent OR failed) for an account, no
 * new alert goes out for that account for ALERT_COOLDOWN_MS. Entries that
 * fail during the cooldown stay un-alerted and are included in the next
 * grouped alert once the window expires.
 *
 * Channels: email only today (see services/email.ts). To add Slack/webhooks
 * later, add another entry to `channels` below — the sweep, grouping, and
 * audit logging are channel-agnostic.
 */

const ALERT_COOLDOWN_MS = 30 * 60_000;
const CONFIG_WARN_INTERVAL_MS = 60 * 60_000;

interface FailedEntry {
  id: string;
  platform: string;
  scheduledAt: Date;
  publishError: string | null;
  retryCount: number;
  socialAccountId: string | null;
  creativeName: string;
  accountName: string | null;
  accountPlatform: string | null;
}

interface AlertChannel {
  name: string;
  deliver(group: AlertGroup, recipients: string[]): Promise<{ sent: boolean; error?: string }>;
}

interface AlertGroup {
  socialAccountId: string | null;
  accountName: string | null;
  accountPlatform: string | null;
  entries: FailedEntry[];
}

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X (Twitter)",
  instagram_feed: "Instagram Feed",
  instagram_story: "Instagram Story",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform;
}

function buildEmailBody(group: AlertGroup): { subject: string; text: string } {
  const n = group.entries.length;
  const accountPart = group.accountName
    ? ` for ${platformLabel(group.accountPlatform || "")} account "${group.accountName}"`
    : " (no social account connected)";
  const subject = `[SparqMake] ${n} scheduled post${n === 1 ? "" : "s"} failed to publish${accountPart}`;

  const lines = group.entries.map((e) => {
    const when = e.scheduledAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    return `• "${e.creativeName}" — ${platformLabel(e.platform)} — scheduled ${when}\n  Reason: ${e.publishError || "Unknown error"}`;
  });

  const text = [
    `${n} scheduled post${n === 1 ? "" : "s"} permanently failed to publish${accountPart}.`,
    "",
    ...lines,
    "",
    "These posts will NOT be retried automatically. Open the Calendar or Review Queue in SparqMake to see details and retry with one click.",
  ].join("\n");

  return { subject, text };
}

const emailChannel: AlertChannel = {
  name: "email",
  async deliver(group, recipients) {
    const { subject, text } = buildEmailBody(group);
    return sendEmail({ to: recipients, subject, text });
  },
};

const channels: AlertChannel[] = [emailChannel];

let lastConfigWarnAt = 0;

async function getAlertRecipients(): Promise<string[]> {
  const users = await db
    .select({ email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(or(eq(usersTable.role, "admin"), eq(usersTable.role, "editor")));
  return users.map((u) => u.email).filter((e) => !!e && e.includes("@"));
}

export async function sweepPublishFailureAlerts(): Promise<void> {
  const failures: FailedEntry[] = await db
    .select({
      id: calendarEntriesTable.id,
      platform: calendarEntriesTable.platform,
      scheduledAt: calendarEntriesTable.scheduledAt,
      publishError: calendarEntriesTable.publishError,
      retryCount: calendarEntriesTable.retryCount,
      socialAccountId: calendarEntriesTable.socialAccountId,
      creativeName: creativesTable.name,
      accountName: socialAccountsTable.accountName,
      accountPlatform: socialAccountsTable.platform,
    })
    .from(calendarEntriesTable)
    .innerJoin(creativesTable, eq(calendarEntriesTable.creativeId, creativesTable.id))
    .leftJoin(socialAccountsTable, eq(calendarEntriesTable.socialAccountId, socialAccountsTable.id))
    .where(
      and(
        eq(calendarEntriesTable.publishStatus, "failed"),
        isNull(calendarEntriesTable.alertedAt),
        or(
          gte(calendarEntriesTable.retryCount, MAX_RETRIES),
          isNull(calendarEntriesTable.socialAccountId),
        ),
      ),
    );

  if (failures.length === 0) return;

  if (!isEmailConfigured()) {
    // Leave entries un-alerted so the email goes out once SMTP is configured;
    // in-app visibility (calendar, review queue, health card) still works.
    const now = Date.now();
    if (now - lastConfigWarnAt >= CONFIG_WARN_INTERVAL_MS) {
      lastConfigWarnAt = now;
      logger.warn(
        { pendingAlerts: failures.length },
        "Permanently failed publishes are awaiting alert delivery, but email is not configured. Set SMTP_HOST, SMTP_FROM (and optionally SMTP_PORT/SMTP_USER/SMTP_PASS) to enable failure alert emails.",
      );
    }
    return;
  }

  // Group per social account (null account id forms its own group).
  const groups = new Map<string, AlertGroup>();
  for (const f of failures) {
    const key = f.socialAccountId ?? "__none__";
    let g = groups.get(key);
    if (!g) {
      g = {
        socialAccountId: f.socialAccountId,
        accountName: f.accountName,
        accountPlatform: f.accountPlatform,
        entries: [],
      };
      groups.set(key, g);
    }
    g.entries.push(f);
  }

  let recipients: string[] | null = null;

  for (const group of groups.values()) {
    // Cooldown: any recent delivery attempt for this account suppresses a new
    // one; the entries stay un-alerted and are grouped into the next alert.
    const accountCondition = group.socialAccountId
      ? eq(publishAlertsTable.socialAccountId, group.socialAccountId)
      : isNull(publishAlertsTable.socialAccountId);
    const [lastAlert] = await db
      .select({ sentAt: publishAlertsTable.sentAt })
      .from(publishAlertsTable)
      .where(accountCondition)
      .orderBy(desc(publishAlertsTable.sentAt))
      .limit(1);
    if (lastAlert && Date.now() - lastAlert.sentAt.getTime() < ALERT_COOLDOWN_MS) {
      continue;
    }

    if (recipients === null) {
      recipients = await getAlertRecipients();
    }
    if (recipients.length === 0) {
      logger.error("Cannot send publish failure alert: no admin/editor users with an email address");
      return;
    }

    const entryIds = group.entries.map((e) => e.id);
    const summary = `${group.entries.length} failed on ${platformLabel(group.entries[0].platform)}: ${(group.entries[0].publishError || "Unknown error").slice(0, 200)}`;

    for (const channel of channels) {
      const result = await channel.deliver(group, recipients);

      await db.insert(publishAlertsTable).values({
        socialAccountId: group.socialAccountId,
        entryIds,
        entryCount: entryIds.length,
        channel: channel.name,
        recipientCount: recipients.length,
        status: result.sent ? "sent" : "failed",
        summary: result.sent ? summary : `${summary} (delivery failed: ${(result.error || "unknown").slice(0, 200)})`,
      });

      if (result.sent) {
        await db
          .update(calendarEntriesTable)
          .set({ alertedAt: new Date() })
          .where(inArray(calendarEntriesTable.id, entryIds));

        // Never log or store recipient addresses — counts only.
        logger.info(
          { socialAccountId: group.socialAccountId, entryCount: entryIds.length, recipientCount: recipients.length, channel: channel.name },
          "Publish failure alert delivered",
        );
      } else {
        logger.error(
          { socialAccountId: group.socialAccountId, entryCount: entryIds.length, channel: channel.name, error: result.error },
          "Publish failure alert delivery failed — will retry after cooldown",
        );
      }

      await recordAudit({
        actor: { id: "system", role: "system" },
        action: result.sent ? "publish_alert.sent" : "publish_alert.failed",
        entityType: "calendar_entry",
        entityIds: entryIds,
        metadata: {
          channel: channel.name,
          socialAccountId: group.socialAccountId,
          recipientCount: recipients.length,
        },
      });
    }
  }
}

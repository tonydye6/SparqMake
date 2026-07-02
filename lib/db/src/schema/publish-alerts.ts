import { pgTable, text, timestamp, json, integer, index } from "drizzle-orm/pg-core";
import { socialAccountsTable } from "./social-accounts";

/**
 * One row per alert delivery attempt for permanently failed scheduled
 * publishes. Rows are grouped per social account (nullable — entries with no
 * connected account form their own group), which lets the sweep enforce a
 * per-account cooldown window so admins get one grouped email instead of one
 * email per failed post. Also serves as an admin-visible send history.
 */
export const publishAlertsTable = pgTable("publish_alerts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  socialAccountId: text("social_account_id").references(() => socialAccountsTable.id, { onDelete: "set null" }),
  // Calendar entry ids covered by this alert (grouped send).
  entryIds: json("entry_ids").notNull().default([]),
  entryCount: integer("entry_count").notNull().default(0),
  // Delivery channel. Only "email" today; designed so Slack/webhooks can be
  // added later without schema changes.
  channel: text("channel").notNull().default("email"),
  recipientCount: integer("recipient_count").notNull().default(0),
  // "sent" | "failed" — failed rows still start the cooldown window so a
  // broken SMTP server isn't hammered every poll.
  status: text("status").notNull().default("sent"),
  // Short human-readable summary (platform + first error), no tokens/PII.
  summary: text("summary"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
}, (table) => [
  index("publish_alerts_account_sent_idx").on(table.socialAccountId, table.sentAt.desc()),
  index("publish_alerts_sent_idx").on(table.sentAt.desc()),
]);

export type PublishAlert = typeof publishAlertsTable.$inferSelect;

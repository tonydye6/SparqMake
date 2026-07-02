import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { calendarEntriesTable } from "./creatives";

// Point-in-time performance snapshots for published posts. One row per fetch,
// so the refinement engine can later consume growth curves, not just the
// latest numbers. All metric columns are nullable because platforms expose
// different subsets (e.g. LinkedIn member posts expose likes/comments but not
// impressions); NULL means "platform did not report this metric", while 0
// means "reported as zero".
export const postMetricsTable = pgTable("post_metrics", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  calendarEntryId: text("calendar_entry_id").notNull()
    .references(() => calendarEntriesTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  impressions: integer("impressions"),
  views: integer("views"),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  // Raw platform API payload for future metrics we don't normalize yet.
  raw: jsonb("raw"),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
}, (table) => [
  index("post_metrics_entry_fetched_idx").on(table.calendarEntryId, table.fetchedAt.desc()),
  index("post_metrics_platform_idx").on(table.platform),
]);

export const insertPostMetricSchema = createInsertSchema(postMetricsTable).omit({
  id: true,
  fetchedAt: true,
});

export type InsertPostMetric = z.infer<typeof insertPostMetricSchema>;
export type PostMetric = typeof postMetricsTable.$inferSelect;

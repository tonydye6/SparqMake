import { pgTable, text, timestamp, json, index, real, integer, numeric, foreignKey, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { brandsTable } from "./brands";
import { templatesTable } from "./templates";
import { socialAccountsTable } from "./social-accounts";
import { usersTable } from "./users";

export const creativesTable = pgTable("creatives", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  templateId: text("template_id").references(() => templatesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  briefText: text("brief_text"),
  referenceUrl: text("reference_url"),
  referenceAnalysis: json("reference_analysis"),
  referenceScreenshots: json("reference_screenshots"),
  selectedAssets: json("selected_assets").notNull().default([]),
  selectedHashtagSets: json("selected_hashtag_sets"),
  sourceCreativeId: text("source_creative_id"),
  estimatedCost: real("estimated_cost"),
  createdBy: text("created_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  reviewedBy: text("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewComment: text("review_comment"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("creatives_brand_status_idx").on(table.brandId, table.status),
  index("creatives_template_created_idx").on(table.templateId, table.createdAt),
  foreignKey({
    columns: [table.sourceCreativeId],
    foreignColumns: [table.id],
    name: "creatives_source_creative_id_creatives_id_fk",
  }).onDelete("set null"),
]);

export const insertCreativeSchema = createInsertSchema(creativesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCreative = z.infer<typeof insertCreativeSchema>;
export type Creative = typeof creativesTable.$inferSelect;

export const creativeVariantsTable = pgTable("creative_variants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").notNull().references(() => creativesTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),
  rawImageUrl: text("raw_image_url"),
  compositedImageUrl: text("composited_image_url"),
  videoUrl: text("video_url"),
  audioSource: text("audio_source"),
  audioUrl: text("audio_url"),
  mergedVideoUrl: text("merged_video_url"),
  caption: text("caption").notNull().default(""),
  originalCaption: text("original_caption"),
  headlineText: text("headline_text"),
  originalHeadline: text("original_headline"),
  status: text("status").notNull().default("generated"),
  // Stores the failure reason (text) when image compositing failed for this
  // variant; NULL means compositing succeeded or was not attempted.
  compositingFailed: text("compositing_failed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("creative_variants_creative_idx").on(table.creativeId),
]);

export const calendarEntriesTable = pgTable("calendar_entries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").notNull().references(() => creativesTable.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => creativeVariantsTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  socialAccountId: text("social_account_id").references(() => socialAccountsTable.id, { onDelete: "set null" }),
  scheduledAt: timestamp("scheduled_at").notNull(),
  publishedAt: timestamp("published_at"),
  publishStatus: text("publish_status").notNull().default("scheduled"),
  publishError: text("publish_error"),
  retryCount: integer("retry_count").notNull().default(0),
  scheduleMethod: text("schedule_method").notNull().default("manual"),
  smartScheduleRationale: text("smart_schedule_rationale"),
  proposalId: text("proposal_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("calendar_entries_status_scheduled_idx").on(table.publishStatus, table.scheduledAt),
  check(
    "calendar_entries_publish_status_check",
    sql`${table.publishStatus} in ('scheduled', 'publishing', 'published', 'failed')`,
  ),
]);

export const smartScheduleProposalsTable = pgTable("smart_schedule_proposals", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").notNull().references(() => creativesTable.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => creativeVariantsTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  proposedAt: timestamp("proposed_at").notNull(),
  score: real("score").notNull().default(0),
  slotScore: real("slot_score"),
  rationale: text("rationale"),
  status: text("status").notNull().default("pending"),
  confirmedAt: timestamp("confirmed_at"),
  finalTime: timestamp("final_time"),
  calendarEntryId: text("calendar_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("smart_schedule_proposals_creative_idx").on(table.creativeId),
]);

export const refinementLogsTable = pgTable("refinement_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").references(() => creativesTable.id, { onDelete: "set null" }),
  templateId: text("template_id").notNull().references(() => templatesTable.id, { onDelete: "cascade" }),
  editType: text("edit_type").notNull(),
  platform: text("platform"),
  aspectRatio: text("aspect_ratio"),
  originalValue: text("original_value"),
  newValue: text("new_value"),
  refinementPrompt: text("refinement_prompt"),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("refinement_logs_template_idx").on(table.templateId, table.editType),
]);

export const costLogsTable = pgTable("cost_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").references(() => creativesTable.id, { onDelete: "set null" }),
  service: text("service").notNull(),
  operation: text("operation").notNull(),
  model: text("model"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 4, mode: "number" }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("cost_logs_created_at_idx").on(table.createdAt.desc()),
  index("cost_logs_service_created_at_idx").on(table.service, table.createdAt.desc()),
]);

export const brandScheduleProfilesTable = pgTable("brand_schedule_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  hour: integer("hour").notNull(),
  score: real("score").notNull().default(0.5),
  status: text("status").notNull().default("acceptable"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("brand_schedule_profiles_unique_idx").on(table.brandId, table.platform, table.dayOfWeek, table.hour),
  index("brand_schedule_profiles_brand_idx").on(table.brandId, table.platform),
]);

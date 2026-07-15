import { pgTable, text, timestamp, json, integer, index } from "drizzle-orm/pg-core";
import { brandsTable } from "./brands";
import { creativesTable, creativeVariantsTable } from "./creatives";

// Taste learning loop: every decision the team makes (picking a take, editing
// a caption, rejecting a variant, tapping a reaction chip) is recorded as a
// taste signal. Signals are periodically distilled by AI into per-brand taste
// guidance that is injected into image and caption prompts.
export const tasteSignalsTable = pgTable("taste_signals", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  creativeId: text("creative_id").references(() => creativesTable.id, { onDelete: "set null" }),
  variantId: text("variant_id").references(() => creativeVariantsTable.id, { onDelete: "set null" }),
  // take_selected | take_passed_over | vary | caption_edit | headline_edit |
  // regenerate | variant_approved | variant_rejected | reaction
  signalType: text("signal_type").notNull(),
  // Structured detail per signal type (varyMode, before/after text, reviewer
  // comment, reaction chip + note, etc.)
  payload: json("payload").notNull().default({}),
  userId: text("user_id"),
  // Set when a distillation run has consumed this signal.
  distilledAt: timestamp("distilled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("taste_signals_brand_undistilled_idx").on(table.brandId, table.distilledAt),
  index("taste_signals_variant_idx").on(table.variantId),
]);

// Versioned history of the distilled guidance so changes are traceable and
// manual edits are never silently lost.
export const tasteGuidanceVersionsTable = pgTable("taste_guidance_versions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  guidance: text("guidance").notNull(),
  // "distilled" (AI run) or "manual" (edited in brand settings)
  source: text("source").notNull(),
  // How many signals fed the distillation run (0 for manual edits).
  signalCount: integer("signal_count").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("taste_guidance_versions_brand_idx").on(table.brandId, table.version),
]);

export type TasteSignal = typeof tasteSignalsTable.$inferSelect;
export type TasteGuidanceVersion = typeof tasteGuidanceVersionsTable.$inferSelect;

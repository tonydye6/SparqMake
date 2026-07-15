import { pgTable, text, timestamp, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { brandsTable } from "./brands";

// Generic external-signal ingestion foundation. Each row is one signal from a
// registered source (performance insights today; in-game telemetry, current
// events, NCAA athlete news later). Sources write typed payloads (jsonb) with
// an optional relevance window; consumers (studio recommendations, fan-out,
// dashboards) filter by sourceType/kind and window without caring where a
// signal came from. `dedupeKey` lets a source upsert its own signals (e.g.
// the performance source refreshes one row per brand+intent) instead of
// appending duplicates.
export const signalsTable = pgTable("signals", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  // Which registered source produced this signal (e.g. "performance").
  sourceType: text("source_type").notNull(),
  // Source-specific signal kind (e.g. "intent_performance" for the
  // performance source; a telemetry source might emit "match_result").
  kind: text("kind").notNull(),
  // Optional brand scoping; NULL = global signal.
  brandId: text("brand_id").references(() => brandsTable.id, { onDelete: "cascade" }),
  // Short human-readable summary rendered directly in UIs.
  title: text("title").notNull(),
  // Source-shaped payload; consumers narrow by sourceType+kind.
  payload: jsonb("payload").notNull(),
  // 0..1 source-assigned strength/confidence; NULL = source did not score it.
  strength: real("strength"),
  // Relevance window: NULL start = relevant since ingestion, NULL end = does
  // not expire. Consumers filter to now ∈ [start, end].
  relevantFrom: timestamp("relevant_from"),
  relevantUntil: timestamp("relevant_until"),
  // Stable per-source identity for upserts (unique together with sourceType).
  dedupeKey: text("dedupe_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("signals_source_kind_idx").on(table.sourceType, table.kind),
  index("signals_brand_idx").on(table.brandId),
  index("signals_relevance_idx").on(table.relevantUntil),
  uniqueIndex("signals_source_dedupe_idx").on(table.sourceType, table.dedupeKey),
]);

export const insertSignalSchema = createInsertSchema(signalsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalsTable.$inferSelect;

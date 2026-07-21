import { pgTable, text, timestamp, json, integer, real, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { brandsTable } from "./brands";
import { creativesTable, creativeVariantsTable } from "./creatives";
import { usersTable } from "./users";

export const studioSessionsTable = pgTable("studio_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  creativeId: text("creative_id").notNull().references(() => creativesTable.id, { onDelete: "cascade" }),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("drafting"),
  imageInteractionId: text("image_interaction_id"),
  videoInteractionId: text("video_interaction_id"),
  activeVariantId: text("active_variant_id").references(() => creativeVariantsTable.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  sessionTitle: text("session_title"),
  lastTurnSummary: text("last_turn_summary"),
  thumbnailUrl: text("thumbnail_url"),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("studio_sessions_brand_idx").on(table.brandId, table.createdAt.desc()),
  index("studio_sessions_creative_idx").on(table.creativeId),
  unique("studio_sessions_creative_id_unique").on(table.creativeId),
]);

export const sessionTurnsTable = pgTable("session_turns", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().references(() => studioSessionsTable.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  instruction: text("instruction"),
  instructionPayload: json("instruction_payload"),
  action: text("action").notNull(),
  resultVariantIds: json("result_variant_ids").$type<string[]>().default(sql`'[]'::json`),
  interactionId: text("interaction_id"),
  costUsd: real("cost_usd"),
  durationMs: integer("duration_ms"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("session_turns_session_seq_idx").on(table.sessionId, table.seq),
]);

export type StudioSession = typeof studioSessionsTable.$inferSelect;
export type SessionTurn = typeof sessionTurnsTable.$inferSelect;

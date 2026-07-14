import { pgTable, text, boolean, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { brandsTable } from "./brands";

export const assetsTable = pgTable("assets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  subType: text("sub_type"),
  status: text("status").notNull().default("uploaded"),
  name: text("name").notNull(),
  description: text("description"),
  tags: text("tags").array().notNull().default([]),
  fileUrl: text("file_url"),
  thumbnailUrl: text("thumbnail_url"),
  content: text("content"),
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  uploadedBy: text("uploaded_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  usageCount: integer("usage_count").notNull().default(0),
  assetClass: text("asset_class"),
  generationRole: text("generation_role"),
  brandLayer: text("brand_layer"),
  franchise: text("franchise"),
  approvedChannels: text("approved_channels").array().default([]),
  approvedTemplates: text("approved_templates").array().default([]),
  subjectIdentityScore: real("subject_identity_score"),
  styleStrengthScore: real("style_strength_score"),
  compositingOnly: boolean("compositing_only").default(false),
  generationAllowed: boolean("generation_allowed").default(true),
  approvedForCompositing: boolean("approved_for_compositing").default(false),
  referencePriorityDefault: real("reference_priority_default"),
  conflictTags: text("conflict_tags").array().default([]),
  freshnessScore: real("freshness_score"),
  characterIdentityNote: text("character_identity_note").notNull().default(""),
  depictedEntities: text("depicted_entities").array().default([]),
  colors: text("colors").array().default([]),
  styleNotes: text("style_notes"),
  aiAnalyzedAt: timestamp("ai_analyzed_at"),
  lastUsedAt: timestamp("last_used_at"),
  fontWeight: text("font_weight"),
  fontName: text("font_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("assets_brand_status_idx").on(table.brandId, table.status),
  index("assets_brand_type_idx").on(table.brandId, table.type),
  index("assets_brand_asset_class_idx").on(table.brandId, table.assetClass),
  index("assets_brand_gen_allowed_idx").on(table.brandId, table.generationAllowed),
  index("assets_brand_franchise_idx").on(table.brandId, table.franchise),
]);

export const insertAssetSchema = createInsertSchema(assetsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;

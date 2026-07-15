import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { brandsTable } from "./brands";

// Named, reusable "design styles" for a brand — a signature look bundling
// mood-board style-reference assets, art-direction language, color treatment
// notes, and an optional preferred logo. Selected per-generation; when chosen,
// its style direction is injected into the image prompt and its reference
// assets are top-priority style references in packet assembly.
export const styleProfilesTable = pgTable("style_profiles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // Composition / art-direction language injected into the image prompt.
  styleDirection: text("style_direction").notNull().default(""),
  // Color treatment guidance (palette, saturation, grading notes).
  colorTreatment: text("color_treatment").notNull().default(""),
  // Asset-library IDs used as mood-board / style references (top priority in
  // packet assembly). Stored as IDs, resolved at generation time so archived
  // or deleted assets degrade gracefully.
  referenceAssetIds: text("reference_asset_ids").array().notNull().default([]),
  // Optional preferred logo asset for this style (informational for now;
  // logo compositing changes are a separate task).
  defaultLogoAssetId: text("default_logo_asset_id"),
  // At most one default per brand is enforced in the route layer (the default
  // is preselected in the generation flow's style picker).
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("style_profiles_brand_idx").on(table.brandId),
]);

export const insertStyleProfileSchema = createInsertSchema(styleProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertStyleProfile = z.infer<typeof insertStyleProfileSchema>;
export type StyleProfile = typeof styleProfilesTable.$inferSelect;

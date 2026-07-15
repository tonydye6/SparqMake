import { pgTable, text, json, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Designer Personas — ACCOUNT-scoped (not brand-scoped) "style inspirations".
//
// Scoping note: this application is single-tenant — there is no accounts
// table; users, brands, settings and templates are all installation-global.
// "Account-scoped" here means brand-INDEPENDENT (reusable across brands), per
// the product spec. If multi-tenancy is ever added, personas need a tenant FK
// and scoped queries alongside every other table; the tenancy seam is
// documented in api-server's middleware/auth.ts (requireMutation).
// Each persona bundles a rich AI-built style fingerprint (typography language,
// composition philosophy, color philosophy, texture/effects, mood) plus
// reference images. Selected per-creative in Studio: the fingerprint is
// injected into the image prompt with look-and-feel precedence over the
// brand's Design Style (brand DNA still applies), and the reference images
// are attached as top-priority style references.
//
// Reference images are stored as plain stored-file URLs (like
// creatives.referenceScreenshots), NOT as brand asset rows — assets require a
// brandId and personas deliberately live above brands.
export interface PersonaReferenceImage {
  url: string;
  label?: string;
}

export const designerPersonasTable = pgTable("designer_personas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  // Short human summary shown on the persona card ("Inspired by ..." framing).
  description: text("description").notNull().default(""),
  // Where the fingerprint came from: "manual" | "url" | "samples".
  sourceType: text("source_type").notNull().default("manual"),
  // Portfolio URL the fingerprint was analyzed from (url source only).
  sourceUrl: text("source_url"),
  // --- Style fingerprint (all prompt-injectable prose) ---
  typography: text("typography").notNull().default(""),
  composition: text("composition").notNull().default(""),
  colorPhilosophy: text("color_philosophy").notNull().default(""),
  textureAndEffects: text("texture_and_effects").notNull().default(""),
  mood: text("mood").notNull().default(""),
  // Reference images: array of { url, label? } stored-file URLs.
  referenceImages: json("reference_images").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDesignerPersonaSchema = createInsertSchema(designerPersonasTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDesignerPersona = z.infer<typeof insertDesignerPersonaSchema>;
export type DesignerPersona = typeof designerPersonasTable.$inferSelect;

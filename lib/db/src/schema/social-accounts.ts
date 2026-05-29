import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { brandsTable } from "./brands";

export const socialAccountsTable = pgTable("social_accounts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  platform: text("platform").notNull(),
  accountName: text("account_name").notNull(),
  accountId: text("account_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry"),
  profileImageUrl: text("profile_image_url"),
  avatarUrl: text("avatar_url"),
  platformMetadata: jsonb("platform_metadata"),
  brandId: text("brand_id").notNull().references(() => brandsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("connected"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("social_accounts_platform_idx").on(table.platform),
  index("social_accounts_brand_idx").on(table.brandId),
  index("social_accounts_status_idx").on(table.status),
  uniqueIndex("social_accounts_platform_account_unique").on(table.platform, table.accountId),
]);

export const insertSocialAccountSchema = createInsertSchema(socialAccountsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSocialAccount = z.infer<typeof insertSocialAccountSchema>;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;

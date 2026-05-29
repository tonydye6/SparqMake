-- Data cleanup (must run before the constraints/types below).
-- These are no-ops on a freshly-migrated empty database.

-- D1: de-duplicate social_accounts on (platform, account_id), keeping the newest
-- row, before the unique index is created.
DELETE FROM "social_accounts" a
USING "social_accounts" b
WHERE a."platform" = b."platform"
  AND a."account_id" = b."account_id"
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."ctid" < b."ctid"));
--> statement-breakpoint
-- D5: backfill any legacy NULL social_accounts.brand_id to a fallback brand
-- before enforcing NOT NULL (new connects always set brand_id explicitly).
UPDATE "social_accounts"
SET "brand_id" = (SELECT "id" FROM "brands" ORDER BY "created_at" ASC LIMIT 1)
WHERE "brand_id" IS NULL;
--> statement-breakpoint
-- D5: clean audit values that don't reference a real user before adding FKs.
-- DEV_AUTH_BYPASS can produce synthetic ids. created_by/user_id are NOT NULL so
-- remap orphans to the earliest real user; reviewed_by is nullable so set NULL.
UPDATE "creatives"
SET "created_by" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1)
WHERE "created_by" NOT IN (SELECT "id" FROM "users");
--> statement-breakpoint
UPDATE "creatives"
SET "reviewed_by" = NULL
WHERE "reviewed_by" IS NOT NULL
  AND "reviewed_by" NOT IN (SELECT "id" FROM "users");
--> statement-breakpoint
UPDATE "refinement_logs"
SET "user_id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1)
WHERE "user_id" NOT IN (SELECT "id" FROM "users");
--> statement-breakpoint
ALTER TABLE "creatives" DROP CONSTRAINT "campaigns_source_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "social_accounts" DROP CONSTRAINT "social_accounts_brand_id_brands_id_fk";
--> statement-breakpoint
DROP INDEX "calendar_entries_schedule_idx";--> statement-breakpoint
DROP INDEX "campaign_variants_campaign_idx";--> statement-breakpoint
DROP INDEX "campaigns_brand_status_idx";--> statement-breakpoint
DROP INDEX "campaigns_template_created_idx";--> statement-breakpoint
ALTER TABLE "cost_logs" ALTER COLUMN "cost_usd" SET DATA TYPE numeric(12, 4) USING "cost_usd"::numeric(12, 4);--> statement-breakpoint
ALTER TABLE "cost_logs" ALTER COLUMN "input_tokens" SET DATA TYPE integer USING "input_tokens"::integer;--> statement-breakpoint
ALTER TABLE "cost_logs" ALTER COLUMN "output_tokens" SET DATA TYPE integer USING "output_tokens"::integer;--> statement-breakpoint
ALTER TABLE "social_accounts" ALTER COLUMN "brand_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_source_creative_id_creatives_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refinement_logs" ADD CONSTRAINT "refinement_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_entries_status_scheduled_idx" ON "calendar_entries" USING btree ("publish_status","scheduled_at");--> statement-breakpoint
CREATE INDEX "creative_variants_creative_idx" ON "creative_variants" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "creatives_brand_status_idx" ON "creatives" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "creatives_template_created_idx" ON "creatives" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_account_unique" ON "social_accounts" USING btree ("platform","account_id");--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_publish_status_check" CHECK ("calendar_entries"."publish_status" in ('scheduled', 'publishing', 'published', 'failed'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('viewer', 'editor', 'admin'));

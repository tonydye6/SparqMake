ALTER TABLE "social_accounts" ADD COLUMN "last_refresh_at" timestamp;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_refresh_error" text;
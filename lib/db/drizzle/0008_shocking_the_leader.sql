CREATE TABLE "publish_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"social_account_id" text,
	"entry_ids" json DEFAULT '[]'::json NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"summary" text,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD COLUMN "alerted_at" timestamp;--> statement-breakpoint
ALTER TABLE "publish_alerts" ADD CONSTRAINT "publish_alerts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_alerts_account_sent_idx" ON "publish_alerts" USING btree ("social_account_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "publish_alerts_sent_idx" ON "publish_alerts" USING btree ("sent_at" DESC NULLS LAST);
CREATE TABLE "post_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"calendar_entry_id" text NOT NULL,
	"platform" text NOT NULL,
	"impressions" integer,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"raw" jsonb,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD COLUMN "platform_post_id" text;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_calendar_entry_id_calendar_entries_id_fk" FOREIGN KEY ("calendar_entry_id") REFERENCES "public"."calendar_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_metrics_entry_fetched_idx" ON "post_metrics" USING btree ("calendar_entry_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_metrics_platform_idx" ON "post_metrics" USING btree ("platform");
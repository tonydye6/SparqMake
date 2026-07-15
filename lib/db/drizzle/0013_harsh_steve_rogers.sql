ALTER TABLE "calendar_entries" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "intent_inference" json;
ALTER TABLE "assets" ADD COLUMN "depicted_entities" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "colors" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "style_notes" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "ai_analyzed_at" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "last_used_at" timestamp;
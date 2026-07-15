ALTER TABLE "creatives" ADD COLUMN "reference_balance" text DEFAULT 'balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "reference_overrides" json;
ALTER TABLE "creative_variants" ADD COLUMN "source_variant_id" text;--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN "vary_mode" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "concept_suggestions" json;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "selected_concept_id" text;--> statement-breakpoint
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_source_variant_id_fk" FOREIGN KEY ("source_variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE set null ON UPDATE no action;
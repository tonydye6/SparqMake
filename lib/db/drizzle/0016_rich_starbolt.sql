CREATE TABLE "taste_guidance_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"version" integer NOT NULL,
	"guidance" text NOT NULL,
	"source" text NOT NULL,
	"signal_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taste_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"creative_id" text,
	"variant_id" text,
	"signal_type" text NOT NULL,
	"payload" json DEFAULT '{}'::json NOT NULL,
	"user_id" text,
	"distilled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "taste_guidance" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "taste_guidance_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "taste_guidance_versions" ADD CONSTRAINT "taste_guidance_versions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_signals" ADD CONSTRAINT "taste_signals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_signals" ADD CONSTRAINT "taste_signals_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_signals" ADD CONSTRAINT "taste_signals_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "taste_guidance_versions_brand_idx" ON "taste_guidance_versions" USING btree ("brand_id","version");--> statement-breakpoint
CREATE INDEX "taste_signals_brand_undistilled_idx" ON "taste_signals" USING btree ("brand_id","distilled_at");--> statement-breakpoint
CREATE INDEX "taste_signals_variant_idx" ON "taste_signals" USING btree ("variant_id");
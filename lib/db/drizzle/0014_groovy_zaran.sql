CREATE TABLE "style_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"style_direction" text DEFAULT '' NOT NULL,
	"color_treatment" text DEFAULT '' NOT NULL,
	"reference_asset_ids" text[] DEFAULT '{}' NOT NULL,
	"default_logo_asset_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "style_profile_id" text;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "style_profiles_brand_idx" ON "style_profiles" USING btree ("brand_id");--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_style_profile_id_style_profiles_id_fk" FOREIGN KEY ("style_profile_id") REFERENCES "public"."style_profiles"("id") ON DELETE set null ON UPDATE no action;
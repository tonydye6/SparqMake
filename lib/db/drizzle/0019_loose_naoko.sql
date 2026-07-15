CREATE TABLE "designer_personas" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"typography" text DEFAULT '' NOT NULL,
	"composition" text DEFAULT '' NOT NULL,
	"color_philosophy" text DEFAULT '' NOT NULL,
	"texture_and_effects" text DEFAULT '' NOT NULL,
	"mood" text DEFAULT '' NOT NULL,
	"reference_images" json DEFAULT '[]'::json NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_variants" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_persona_id_designer_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."designer_personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_persona_id_designer_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."designer_personas"("id") ON DELETE set null ON UPDATE no action;
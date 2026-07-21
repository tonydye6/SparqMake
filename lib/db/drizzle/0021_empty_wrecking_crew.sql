CREATE TABLE "session_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"instruction" text,
	"instruction_payload" json,
	"action" text NOT NULL,
	"result_variant_ids" json DEFAULT '[]'::json,
	"interaction_id" text,
	"cost_usd" real,
	"duration_ms" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"metadata" json,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"image_interaction_id" text,
	"video_interaction_id" text,
	"active_variant_id" text,
	"created_by" text NOT NULL,
	"session_title" text,
	"last_turn_summary" text,
	"thumbnail_url" text,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "voice_examples" json;--> statement-breakpoint
ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_session_id_studio_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."studio_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_active_variant_id_creative_variants_id_fk" FOREIGN KEY ("active_variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_turns_session_seq_idx" ON "session_turns" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "studio_sessions_brand_idx" ON "studio_sessions" USING btree ("brand_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "studio_sessions_creative_idx" ON "studio_sessions" USING btree ("creative_id");
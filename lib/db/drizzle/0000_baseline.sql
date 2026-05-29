CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color_primary" text DEFAULT '#3B82F6' NOT NULL,
	"color_secondary" text DEFAULT '#1E3A5F' NOT NULL,
	"color_accent" text DEFAULT '#60A5FA' NOT NULL,
	"color_background" text DEFAULT '#0A0A0F' NOT NULL,
	"voice_description" text DEFAULT '' NOT NULL,
	"banned_terms" text[] DEFAULT '{}' NOT NULL,
	"trademark_rules" text DEFAULT '' NOT NULL,
	"hashtag_strategy" json DEFAULT '{}'::json NOT NULL,
	"character_style_rules" text DEFAULT '' NOT NULL,
	"imagen_prefix" text DEFAULT '' NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"platform_rules" json DEFAULT '{}'::json NOT NULL,
	"logo_file_url" text,
	"brand_fonts" json,
	"brand_asset_config" json,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "brands_name_unique" UNIQUE("name"),
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"imagen_prompt_addition" text DEFAULT '' NOT NULL,
	"imagen_negative_addition" text DEFAULT '' NOT NULL,
	"claude_caption_instruction" json DEFAULT '{}'::json NOT NULL,
	"claude_headline_instruction" text,
	"layout_spec" json,
	"recommended_asset_types" text[] DEFAULT '{}' NOT NULL,
	"target_aspect_ratios" text[] DEFAULT '{"1:1","4:5","9:16","16:9"}' NOT NULL,
	"total_generations" integer DEFAULT 0 NOT NULL,
	"first_pass_approval_rate" real,
	"avg_refinements_before_approval" real,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" json NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"change_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_recommendations" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"analysis_data" json NOT NULL,
	"recommendations" json NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp,
	"reviewer_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"type" text NOT NULL,
	"sub_type" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"file_url" text,
	"thumbnail_url" text,
	"content" text,
	"mime_type" text,
	"file_size_bytes" integer,
	"uploaded_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"asset_class" text,
	"generation_role" text,
	"brand_layer" text,
	"franchise" text,
	"approved_channels" text[] DEFAULT '{}',
	"approved_templates" text[] DEFAULT '{}',
	"subject_identity_score" real,
	"style_strength_score" real,
	"compositing_only" boolean DEFAULT false,
	"generation_allowed" boolean DEFAULT true,
	"approved_for_compositing" boolean DEFAULT false,
	"reference_priority_default" real,
	"conflict_tags" text[] DEFAULT '{}',
	"freshness_score" real,
	"character_identity_note" text DEFAULT '' NOT NULL,
	"font_weight" text,
	"font_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"primary_asset_id" text NOT NULL,
	"secondary_asset_id" text NOT NULL,
	"template_id" text,
	"platform" text,
	"first_pass_approved" boolean,
	"total_refinements" integer DEFAULT 0 NOT NULL,
	"final_status" text,
	"usage_count" integer DEFAULT 1 NOT NULL,
	"avg_approval_score" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_packet_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"platform" text,
	"template_id" text,
	"packet_type" text,
	"primary_asset_id" text,
	"supporting_asset_ids" json,
	"style_asset_ids" json,
	"context_asset_ids" json,
	"compositing_asset_ids" json,
	"excluded_asset_ids" json,
	"packet_reasoning" json,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hashtag_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"hashtags" text[] DEFAULT '{}' NOT NULL,
	"category" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_schedule_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"platform" text NOT NULL,
	"day_of_week" integer NOT NULL,
	"hour" integer NOT NULL,
	"score" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'acceptable' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"platform" text NOT NULL,
	"social_account_id" text,
	"scheduled_at" timestamp NOT NULL,
	"published_at" timestamp,
	"publish_status" text DEFAULT 'scheduled' NOT NULL,
	"publish_error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"schedule_method" text DEFAULT 'manual' NOT NULL,
	"smart_schedule_rationale" text,
	"proposal_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"cost_usd" real NOT NULL,
	"input_tokens" text,
	"output_tokens" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"platform" text NOT NULL,
	"aspect_ratio" text NOT NULL,
	"raw_image_url" text,
	"composited_image_url" text,
	"video_url" text,
	"audio_source" text,
	"audio_url" text,
	"merged_video_url" text,
	"caption" text DEFAULT '' NOT NULL,
	"original_caption" text,
	"headline_text" text,
	"original_headline" text,
	"status" text DEFAULT 'generated' NOT NULL,
	"compositing_failed" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"template_id" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"brief_text" text,
	"reference_url" text,
	"reference_analysis" json,
	"reference_screenshots" json,
	"selected_assets" json DEFAULT '[]'::json NOT NULL,
	"selected_hashtag_sets" json,
	"source_creative_id" text,
	"estimated_cost" real,
	"created_by" text NOT NULL,
	"reviewed_by" text,
	"review_comment" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refinement_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text,
	"template_id" text NOT NULL,
	"edit_type" text NOT NULL,
	"platform" text,
	"aspect_ratio" text,
	"original_value" text,
	"new_value" text,
	"refinement_prompt" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_schedule_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"creative_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"platform" text NOT NULL,
	"proposed_at" timestamp NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"slot_score" real,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp,
	"final_time" timestamp,
	"calendar_entry_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"account_name" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_expiry" timestamp,
	"profile_image_url" text,
	"avatar_url" text,
	"platform_metadata" jsonb,
	"brand_id" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_content_plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"campaign_name" text,
	"primary_platform" text NOT NULL,
	"secondary_platforms" text[] DEFAULT '{}' NOT NULL,
	"template_name" text,
	"pillar" text,
	"audience" text,
	"brand_layer" text,
	"objective" text,
	"content_type" text,
	"asset_packet_type" text,
	"core_message" text,
	"cta" text,
	"required_asset_roles" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"planned_week" text,
	"planned_date" text,
	"notes" text,
	"linked_creative_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_recommendations" ADD CONSTRAINT "template_recommendations_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_pairings" ADD CONSTRAINT "asset_pairings_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_pairings" ADD CONSTRAINT "asset_pairings_primary_asset_id_assets_id_fk" FOREIGN KEY ("primary_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_pairings" ADD CONSTRAINT "asset_pairings_secondary_asset_id_assets_id_fk" FOREIGN KEY ("secondary_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_pairings" ADD CONSTRAINT "asset_pairings_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_packet_logs" ADD CONSTRAINT "generation_packet_logs_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_packet_logs" ADD CONSTRAINT "generation_packet_logs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_packet_logs" ADD CONSTRAINT "generation_packet_logs_primary_asset_id_assets_id_fk" FOREIGN KEY ("primary_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_sets" ADD CONSTRAINT "hashtag_sets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_schedule_profiles" ADD CONSTRAINT "brand_schedule_profiles_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_logs" ADD CONSTRAINT "cost_logs_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "campaigns_source_campaign_id_campaigns_id_fk" FOREIGN KEY ("source_creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refinement_logs" ADD CONSTRAINT "refinement_logs_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refinement_logs" ADD CONSTRAINT "refinement_logs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_schedule_proposals" ADD CONSTRAINT "smart_schedule_proposals_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_schedule_proposals" ADD CONSTRAINT "smart_schedule_proposals_variant_id_creative_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."creative_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_content_plan_items" ADD CONSTRAINT "social_content_plan_items_linked_creative_id_creatives_id_fk" FOREIGN KEY ("linked_creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_recommendations_template_idx" ON "template_recommendations" USING btree ("template_id","status");--> statement-breakpoint
CREATE INDEX "assets_brand_status_idx" ON "assets" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "assets_brand_type_idx" ON "assets" USING btree ("brand_id","type");--> statement-breakpoint
CREATE INDEX "assets_brand_asset_class_idx" ON "assets" USING btree ("brand_id","asset_class");--> statement-breakpoint
CREATE INDEX "assets_brand_gen_allowed_idx" ON "assets" USING btree ("brand_id","generation_allowed");--> statement-breakpoint
CREATE INDEX "assets_brand_franchise_idx" ON "assets" USING btree ("brand_id","franchise");--> statement-breakpoint
CREATE INDEX "asset_pairings_primary_idx" ON "asset_pairings" USING btree ("primary_asset_id");--> statement-breakpoint
CREATE INDEX "asset_pairings_secondary_idx" ON "asset_pairings" USING btree ("secondary_asset_id");--> statement-breakpoint
CREATE INDEX "asset_pairings_template_idx" ON "asset_pairings" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "asset_pairings_campaign_idx" ON "asset_pairings" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "gen_packet_logs_campaign_idx" ON "generation_packet_logs" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "gen_packet_logs_template_idx" ON "generation_packet_logs" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "hashtag_sets_brand_category_idx" ON "hashtag_sets" USING btree ("brand_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_schedule_profiles_unique_idx" ON "brand_schedule_profiles" USING btree ("brand_id","platform","day_of_week","hour");--> statement-breakpoint
CREATE INDEX "brand_schedule_profiles_brand_idx" ON "brand_schedule_profiles" USING btree ("brand_id","platform");--> statement-breakpoint
CREATE INDEX "calendar_entries_schedule_idx" ON "calendar_entries" USING btree ("scheduled_at","publish_status");--> statement-breakpoint
CREATE INDEX "cost_logs_created_at_idx" ON "cost_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_logs_service_created_at_idx" ON "cost_logs" USING btree ("service","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaign_variants_campaign_idx" ON "creative_variants" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "campaigns_brand_status_idx" ON "creatives" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_template_created_idx" ON "creatives" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE INDEX "refinement_logs_template_idx" ON "refinement_logs" USING btree ("template_id","edit_type");--> statement-breakpoint
CREATE INDEX "smart_schedule_proposals_creative_idx" ON "smart_schedule_proposals" USING btree ("creative_id");--> statement-breakpoint
CREATE INDEX "social_accounts_platform_idx" ON "social_accounts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "social_accounts_brand_idx" ON "social_accounts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "social_accounts_status_idx" ON "social_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plan_items_status_idx" ON "social_content_plan_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "plan_items_pillar_idx" ON "social_content_plan_items" USING btree ("pillar");--> statement-breakpoint
CREATE INDEX "plan_items_platform_idx" ON "social_content_plan_items" USING btree ("primary_platform");--> statement-breakpoint
CREATE INDEX "plan_items_week_idx" ON "social_content_plan_items" USING btree ("planned_week");
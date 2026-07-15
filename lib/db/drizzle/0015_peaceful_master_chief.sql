CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"source_type" text NOT NULL,
	"kind" text NOT NULL,
	"brand_id" text,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"strength" real,
	"relevant_from" timestamp,
	"relevant_until" timestamp,
	"dedupe_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_source_kind_idx" ON "signals" USING btree ("source_type","kind");--> statement-breakpoint
CREATE INDEX "signals_brand_idx" ON "signals" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "signals_relevance_idx" ON "signals" USING btree ("relevant_until");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_source_dedupe_idx" ON "signals" USING btree ("source_type","dedupe_key");
CREATE TABLE "cost_log_monthly_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"month" timestamp NOT NULL,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"total_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cost_log_monthly_summary_unique_idx" ON "cost_log_monthly_summary" USING btree ("month","service","operation");--> statement-breakpoint
CREATE INDEX "cost_log_monthly_summary_month_idx" ON "cost_log_monthly_summary" USING btree ("month" DESC NULLS LAST);
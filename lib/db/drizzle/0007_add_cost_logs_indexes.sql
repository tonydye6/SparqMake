-- Indexes on cost_logs to keep analytics and budget queries fast as the table grows.
-- Most queries filter/sort by created_at DESC, often combined with service.
CREATE INDEX IF NOT EXISTS "cost_logs_created_at_idx"
  ON "cost_logs" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "cost_logs_service_created_at_idx"
  ON "cost_logs" ("service", "created_at" DESC);

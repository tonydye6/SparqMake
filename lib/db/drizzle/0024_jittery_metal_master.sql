-- A3: Drizzle-generated snapshot remediation for the unique constraint added
-- by 0022 (hand-written, no snapshot).  Environments where 0022 already ran
-- have the constraint; this guard makes the migration a no-op in that case.
DO $$ BEGIN
  ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_creative_id_unique" UNIQUE("creative_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;
-- Add unique constraint: one session per creative (1:1 enforcement)
DO $$ BEGIN
  ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_creative_id_unique" UNIQUE("creative_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

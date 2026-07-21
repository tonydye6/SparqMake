-- F2: Index on studio_sessions(brand_id, updated_at DESC) to make the
-- "continue rail" query fast.  Without it, GET /api/sessions?brandId=...
-- performs a full table scan ordered by updated_at.
-- Note: CONCURRENTLY removed — Drizzle runs migrations inside a transaction
-- block on this stack; CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX IF NOT EXISTS
  studio_sessions_brand_updated_idx
  ON studio_sessions (brand_id, updated_at DESC);

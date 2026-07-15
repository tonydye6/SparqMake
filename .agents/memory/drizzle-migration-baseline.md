---
name: Drizzle migration baseline on a push-built DB
description: How to recover when drizzle `migrate` fails on an existing schema because the __drizzle_migrations journal is empty
---

When a database schema was originally created with `drizzle-kit push` (or seeded
out-of-band) and the project later switches to versioned `drizzle-kit migrate`,
the `drizzle.__drizzle_migrations` journal can be EMPTY while the tables already
exist. `migrate` then tries to apply `0000_baseline` from scratch and dies with
Postgres `heap_create_with_catalog` / "relation already exists" (file `heap.c`).

**Why:** drizzle decides what to apply by a watermark — the max `created_at` in
`__drizzle_migrations`. Empty journal ⇒ watermark is nothing ⇒ it replays every
migration including the baseline CREATE TABLEs against tables that already exist.

**How to apply (one-time, in Build mode):**
1. Insert ONE baseline row into `drizzle.__drizzle_migrations (hash, created_at)`
   where `created_at` = the `when` of `0000_baseline` in `meta/_journal.json`
   (exact value matters — it's the watermark). `hash` = sha256 of the
   `0000_baseline.sql` file contents (value isn't checked for skip logic, but
   compute the real one). Make the insert idempotent (`WHERE NOT EXISTS ... created_at`).
2. Run `pnpm --filter db migrate`. drizzle applies only migrations whose `when`
   is greater than the baseline's, recording each. Verify before running that the
   later migrations' DDL is actually safe against current data (e.g. type casts
   are castable, dropped constraints/indexes exist), since this DB may have
   partial drift vs. a clean migrate.
3. Re-run `scripts/post-merge.sh` to confirm exit 0.

**Critical:** This same failure breaks EVERY task merge's post-merge step until
fixed, and it will ALSO break PRODUCTION deploys if the prod DB has tables with
an empty journal. For Replit-managed Postgres, prod schema is applied at Publish
time (diff dev→prod), so baseline/verify the prod state when first deploying.

Note: a task agent's direct `psql`/migrate against ITS isolated env does NOT
affect the main dev DB — verify the main dev DB's real state, don't assume a
merged task already applied its migration here.

## Parallel-task migration collisions
When two tasks both generate migration N in parallel, resolve the rebase by keeping main's N (and snapshots/journal), deleting your migration file, and regenerating yours as the next index with `pnpm --filter @workspace/db run generate`. If the dev DB already applied your old migration, drop the affected column/table and delete its `drizzle.__drizzle_migrations` row before `migrate`, or it fails with a name-collision error.

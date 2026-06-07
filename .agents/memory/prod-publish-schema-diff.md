---
name: Prod publish schema diff vs versioned migrations
description: Why Replit's publish-time schema diff can fail for this project and how prod schema actually gets updated.
---

# Production schema is owned by Replit's publish-time diff, NOT our drizzle migrations

This project ships versioned drizzle migrations (`lib/db/drizzle/*.sql`) applied to the
**dev** DB via `scripts/post-merge.sh` (`pnpm --filter db migrate`). Those migrations
include hand-written data-cleanup steps and proper `USING` casts.

**Production does NOT run those migrations.** There is no deploy-time migrate hook
(forbidden by the database skill), so prod schema is updated only by Replit's
Publish flow, which computes its **own** dev↔prod schema diff and applies naive
`ALTER`s.

**Why:** Replit's auto-diff cannot emit casts our migrations do. Classic failure:
`ALTER TABLE cost_logs ALTER COLUMN input_tokens SET DATA TYPE integer` with no
`USING` → "column cannot be cast automatically to type integer". This fails even on
an EMPTY column (text→integer has no implicit cast). Our drizzle `0001` does the same
change correctly with `USING "input_tokens"::integer`, but that SQL never reaches prod.

**Consequence:** prod can drift far behind dev (observed: prod ≈ baseline 0000 while
dev = 0005). Most of the diff was safe because the other changed tables were empty in
prod; only the text→integer cast on the (empty) cost_logs token columns blocked publish.

**How to apply / escape hatches when publish validation fails on a cast:**
- The supported one-click fixes in the Publish UI are: (a) "Copy development schema &
  data to production" (wholesale overwrite — destroys prod data) or (b) cancel + resolve.
- Before recommending (a), ALWAYS compare dev vs prod data — they may be different real
  datasets (observed: prod user `tony@sparqgames.com` + "Corporate" brand vs dev's
  bypass user + "Sparq" brand). Wholesale copy erases the real prod rows.
- Agent must NOT run DDL on prod, add deploy migrate hooks, or write prod migration
  scripts. Data-safe dev-side alternative when keeping prod data matters: change the
  schema source of truth so the diff no longer contains the impossible cast (e.g.
  rename the column to a new name so the diff becomes drop+add, both auto-applicable),
  apply to dev, then re-publish.

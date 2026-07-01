---
name: Dev-bypass user lifecycle & cleanup
description: How the dev-bypass account is created/removed, why stale copies survive, and the safe cleanup contract.
---

# Dev-bypass account lifecycle

The dev-bypass user (id `dev-user-00000000-0000-0000-0000-000000000000`) lives in
`artifacts/api-server/src/middleware/auth.ts`.

**Create is insert-only, never update.** `ensureDevUser()` inserts only when the id
is missing. So the account's `email` is frozen at whatever the *creating* build
used. After the SparqForge→SparqMake rename the DB kept the legacy
`dev@sparqforge.local` email even though code defines `dev@sparqmake.local`. Both
dev and prod DBs showed the stale email.

**Removal only happens at process startup.** When the bypass is off (always true in
a deployed env — the guard keys off `REPLIT_DEPLOYMENT`), startup deletes the
account. Historically this was an unawaited import side-effect with swallowed
errors, so a stale/never-restarted deployment silently kept the account.

**Why prod kept the stray account:** the record was created 2026-03-21 by a build
with *no* cleanup; the delete-cleanup was added ~2026-03-23; prod was never
redeployed after that, so the cleanup code never ran in the prod process. Nothing
in prod ever restarted with the cleanup present.

**Cleanup contract now:** `cleanupDevBypassUser()` (exported) is invoked from the
controlled bootstrap in `index.ts` (awaited, logged) before the server serves.
It deletes strictly by the reserved identity — fixed id OR any historical email in
`DEV_BYPASS_EMAILS` (`sparqmake.local` + legacy `sparqforge.local`). Those literals
can never belong to a real user, so it cannot delete legitimate accounts.

**How to apply:** removing the *existing* prod row requires a redeploy/republish —
the agent cannot write to prod. Adding a future dev-bypass email? add it to
`DEV_BYPASS_EMAILS` so cleanup still catches drifted rows.

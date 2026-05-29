# SparqMake — Data Model & Dependencies / Supply-Chain Review

**Repository:** https://github.com/tonydye6/SparqMake
**Reviewed at commit:** `6e7fe4d` ("Improve upload safety and secure social login flows") — current `main`.
**Scope:** (1) the Drizzle/Postgres schema — constraints, indexes, referential integrity, ownership/scoping, money/typing, migration hygiene; (2) dependencies & supply-chain posture — version pinning, install-script allowlisting, pool sizing, vuln scanning.
**Predecessors:** Fourth doc in this effort, after the Backend Code Review (`7123867`), the Security Fix Verification (`5b8cf12`), and the Infra & Deployment Review (`6e7fe4d`). This one does **not** re-cover those areas.
**Audience:** The Replit AI Agent implementing SparqMake.

---

## How to read this document

- **Severity:** 🔴 Critical → 🟠 High → 🟡 Medium → ⚪ Low → ℹ️ Informational.
- Every item cites `file:line` at commit `6e7fe4d`. Line numbers may drift — search for the quoted code if they don't match.
- Fixes are minimal and targeted. **Do not refactor beyond each fix.**
- **Schema changes on a live DB need care.** Several fixes alter existing columns/constraints. Where a change can fail on existing data (duplicate rows, type casts), the step says so — follow the ordering.
- This codebase applies schema via `drizzle-kit push` (see **M-A**), so "the fix" is usually an edit to the `*.ts` schema file; the deploy then syncs it. Verify each `push` diff before accepting it.

---

## At-a-glance

| # | Sev | Finding | Anchor at `6e7fe4d` |
|---|-----|---------|---------------------|
| D1 | 🟠 | `social_accounts` has no unique constraint on `(platform, account_id)` — the new upsert is a TOCTOU race | `schema/social-accounts.ts:6-25` |
| D2 | 🟠 | Money stored as `real` (float) in `cost_logs.cost_usd` — backs the budget gate | `schema/creatives.ts:125-138` |
| M-A | 🟡 | `push`-only workflow + hand-written migrations + no `migrate` runner / no `0000` baseline | `lib/db/package.json:10-13`, `lib/db/drizzle/` |
| D3 | 🟡 | `conversations` & `messages` tables orphaned + invisible to migrations | `schema/conversations.ts`, `schema/messages.ts`, `schema/index.ts` |
| D4 | 🟡 | Scheduler hot-path index is in the wrong column order | `schema/creatives.ts:87`, `services/publish-scheduler.ts:328-345` |
| D5 | 🟡 | No referential integrity / unclear ownership for `users`-owned and social rows | `schema/creatives.ts:22-23`, `schema/social-accounts.ts` |
| S1 | 🟡 | Build-script allowlist fragmented across **4** disjoint sources | `package.json`, `pnpm-workspace.yaml`, `.pnpm-approved-builds.json`, `.pnpm-build-config.json` |
| S2 | 🟡 | No `packageManager` / `engines` pinning | `package.json` (root) |
| S4 | 🟡 | DB pool has no sizing (default `max:10`/instance) — multiplies on autoscale | `lib/db/src/index.ts` |
| D6 | ⚪ | Status/role columns are unconstrained `text` (no enum/CHECK) | multiple |
| D7 | ⚪ | Legacy `campaigns_*` index names; `compositing_failed` typed `text` | `schema/creatives.ts:29-34,63` |
| S3 | ⚪ | `@types/node ^25` vs Node 24 runtime; `@types/multer` in `dependencies` | `pnpm-workspace.yaml`, `artifacts/api-server/package.json:13` |
| S5 | ℹ️ | No automated vuln scanning (`pnpm audit` / Dependabot) | CI |

---

# Part 1 — Data Model

## 🟠 D1 — `social_accounts` has no unique constraint; the new upsert is a race

**Where.** `schema/social-accounts.ts:6-25` has indexes on `platform`, `brand_id`, `status`, but **no unique constraint** on `(platform, account_id)`. The `social-auth.ts` fix you just shipped works around this with a select-then-insert/update:

```ts
// social-auth.ts — upsertSocialAccount (current)
const [existing] = await db.select(...).where(and(
  eq(socialAccountsTable.platform, values.platform),
  eq(socialAccountsTable.accountId, values.accountId),
));
if (existing) { /* update */ } else { /* insert */ }
```

**Problem.** This is a **TOCTOU race**: two concurrent callbacks for the same account both run the `SELECT`, both see no row, and both `INSERT` → **duplicate rows**, which nothing then dedupes. The app-level upsert cannot be made safe without a DB-level uniqueness guarantee. (The agent's own comment notes "no DB unique constraint exists on platform+accountId" — this is that gap.)

**Fix — add the constraint, then make it a real upsert.**

1. **De-dupe existing rows first** (the constraint creation fails if duplicates exist). One-off SQL, keep the newest per `(platform, account_id)`:

```sql
DELETE FROM social_accounts a
USING social_accounts b
WHERE a.platform = b.platform
  AND a.account_id = b.account_id
  AND a.created_at < b.created_at;
```

2. **Add the unique index** in `schema/social-accounts.ts`:

```ts
// schema/social-accounts.ts — add to the index array (currently lines 21-25)
import { /* … */ uniqueIndex } from "drizzle-orm/pg-core";

}, (table) => [
  uniqueIndex("social_accounts_platform_account_unique").on(table.platform, table.accountId), // ADD
  index("social_accounts_platform_idx").on(table.platform),
  index("social_accounts_brand_idx").on(table.brandId),
  index("social_accounts_status_idx").on(table.status),
]);
```

3. **Convert `upsertSocialAccount` to a real `ON CONFLICT`** (atomic, race-free):

```ts
await db.insert(socialAccountsTable)
  .values(values)
  .onConflictDoUpdate({
    target: [socialAccountsTable.platform, socialAccountsTable.accountId],
    set: { /* the same fields you update today; keep the refreshToken-only-if-present logic */ },
  });
```

> Do not change the OAuth flow logic — only the persistence call.

---

## 🟠 D2 — Money is a `real` (float); it backs the budget ceiling

**Where.** `schema/creatives.ts:125-138`, `cost_logs`:

```ts
costUsd: real("cost_usd").notNull(),          // ← float
inputTokens: text("input_tokens"),            // ← should be integer
outputTokens: text("output_tokens"),          // ← should be integer
```

**Problem.** `cost_logs` is the table the budget **reserve/settle** gate sums against (`generate.ts`). Floating-point (`real` = 32-bit) accumulates rounding error across many rows, so a spend ceiling computed by `SUM(cost_usd)` drifts and is not exactly auditable. Money should never be a float. (`creatives.estimated_cost` at `:21` is also `real`, but it's an estimate, so lower priority.)

**Fix — use `numeric` for currency and `integer` for token counts.**

```ts
import { numeric, integer /* … */ } from "drizzle-orm/pg-core";

costUsd: numeric("cost_usd", { precision: 12, scale: 4 }).notNull(),
inputTokens: integer("input_tokens"),
outputTokens: integer("output_tokens"),
```

> `numeric` maps to a string in drizzle's JS type — update the budget sum/compare in `generate.ts` to parse it (e.g. `Number(row.costUsd)` or a decimal lib) so the reserve/settle math still works. The `real`→`numeric` column change needs a `USING cost_usd::numeric` cast; confirm the `push` diff applies it (drizzle may need a manual migration for the cast). Test the budget gate end-to-end after.

---

## 🟡 M-A — `push`-only workflow with hand-written migrations and no runner

**Where.** `lib/db/package.json:10-13` exposes only:

```json
"scripts": {
  "push": "drizzle-kit push --config ./drizzle.config.ts",
  "push-force": "drizzle-kit push --force --config ./drizzle.config.ts"
}
```

There is **no `migrate` and no `generate` script.** Yet `lib/db/drizzle/` contains hand-written `0001`–`0007` SQL files — and **no `0000` baseline** (the initial table creation isn't represented). So `drizzle-kit push` (live schema diffing) is the *actual* apply path, and the committed `.sql` files are effectively undocumented drift notes that may not match what `push` produced.

**Why it matters.** This is precisely why **infra-review M1** (switch the deploy hook from `push` to `migrate`) could not be implemented — there is no migrate runner to switch to. `push` on a production DB can drop/alter columns on drift (see infra M1), and mixing it with partial hand-written migrations means no deterministic, reviewable history.

**Fix — adopt a real migration workflow (this also closes infra M1):**

1. Add scripts to `lib/db/package.json`:

```json
"generate": "drizzle-kit generate --config ./drizzle.config.ts",
"migrate":  "drizzle-kit migrate --config ./drizzle.config.ts"
```

2. Baseline the current production schema as `0000` (use `drizzle-kit generate` against an empty DB, or `introspect` the live DB) so the history is complete.
3. Switch the deploy hook (`scripts/post-merge.sh:4`) from `pnpm --filter db push` to `pnpm --filter db migrate`.
4. Keep `push` for local dev only.

> This is a process change — coordinate with Tony before reworking the migration baseline, since it touches how prod schema is applied.

---

## 🟡 D3 — `conversations` & `messages` are orphaned and invisible to migrations

**Where.**
- `schema/conversations.ts` and `schema/messages.ts` define `conversations`/`messages` with **`serial` integer PKs** — unlike every other table, which uses `text` UUID PKs (a different vintage).
- `schema/index.ts` (the barrel) exports 12 modules but **omits `./conversations` and `./messages`**.
- `drizzle.config.ts:9` reads exactly that barrel: `schema: path.join(__dirname, "./src/schema/index.ts")`.
- No application code references these tables (grep: only the unrelated AI-SDK `messages:` arrays appear).

**Problem.** Because they're excluded from the barrel, `push`/migrations will **never create them**. They're dead code today, and a landmine: if anyone imports and uses them, queries hit a non-existent relation at runtime.

**Fix — delete both files** (`schema/conversations.ts`, `schema/messages.ts`). They're unused, unexported, and uncreated. If a chat feature is planned later, re-add them with UUID PKs and export from the barrel.

---

## 🟡 D4 — Scheduler hot-path index is in the wrong column order

**Where.** The poller runs every interval on (currently) every instance — `services/publish-scheduler.ts:328-345`:

```ts
// readyEntries
.where(and(lte(calendarEntriesTable.scheduledAt, now),
           eq(calendarEntriesTable.publishStatus, "scheduled")))
// failedEntries
.where(eq(calendarEntriesTable.publishStatus, "failed"))
```

The index is `schema/creatives.ts:87`:

```ts
index("calendar_entries_schedule_idx").on(table.scheduledAt, table.publishStatus)  // (range, equality)
```

**Problem.** Both queries filter by **equality on `publish_status`** (plus a range on `scheduled_at` for the first). A composite index is most effective with the equality column **first**. Leading with `scheduled_at` means the `publish_status = 'failed'` query can't use the index well (effectively scans), and the `'scheduled'` query is suboptimal. Also, the "failed" query pulls **all** failed rows every poll — including ones already at `MAX_RETRIES` — then filters in JS (`:347-352`), so the scan grows unbounded as failures accumulate.

**Fix.**

1. Reorder the composite to equality-first:

```ts
index("calendar_entries_status_schedule_idx").on(table.publishStatus, table.scheduledAt)
```

2. Narrow the failed-entries query so maxed-out retries aren't re-scanned forever:

```ts
.where(and(
  eq(calendarEntriesTable.publishStatus, "failed"),
  lt(calendarEntriesTable.retryCount, MAX_RETRIES),   // ADD
))
```

> Keep the JS backoff filter; just stop fetching permanently-failed rows.

---

## 🟡 D5 — No referential integrity to `users`; social-account ownership is undefined

**Where.**
- `schema/creatives.ts:22-23` — `created_by`/`reviewed_by` are plain `text` with **no FK** to `users.id`. Same for `refinement_logs.user_id` (`:119`).
- `schema/social-accounts.ts` — has **no `user_id` column at all**, and `brand_id` is nullable (`onDelete: "set null"`). The OAuth connect path (`social-auth.ts`) inserts **without `brand_id`**, so connected accounts start **unowned by any brand**.

**Problem.** Ownership of creatives and social accounts isn't enforced at the DB level. Deleting a user leaves dangling `created_by`. Social accounts have neither a user nor (initially) a brand, so the scoping model is ambiguous — and combined with D1's global `(platform, account_id)` match, a reconnect from a different context can silently overwrite the row's owning `brand_id`.

**Fix (decide the model first, then enforce):**
- If accounts/creatives are **brand-scoped** (consistent with the rest of the app): set `brand_id` on social-account connect, make it `notNull` once backfilled, and keep brand cascade. 
- If **user-scoped**: add a `user_id text references users(id)` column.
- Add FKs for `creatives.created_by`/`reviewed_by` → `users.id` (`onDelete: "set null"`) so audit fields can't dangle.

> This is a modeling decision — confirm user-vs-brand scoping with Tony before adding `notNull` columns that need a backfill.

---

## ⚪ D6 — Status/role columns are unconstrained `text`

`publish_status`, creative & variant `status`, and `users.role` are free `text` (e.g. `creatives.ts:13,62,78`; `users.ts:10`). A typo'd status (`"publishng"`) is silently accepted and would break the status-keyed scheduler queries (D4). RBAC compares `role === "admin"` etc., so an invalid role **fails closed** (safe), but is still better constrained. Consider `pgEnum` or `CHECK` constraints on the load-bearing ones — `publish_status` and `role` first.

## ⚪ D7 — Cosmetic schema debt

- `creatives` table carries **legacy `campaigns_*` index/constraint names** from the `0004` campaign→creative rename (`creatives.ts:29-34`). Harmless; rename for clarity.
- `creative_variants.compositing_failed` is typed `text` for what reads as a boolean/error flag (`creatives.ts:63`). Consider `boolean` + a separate error `text`, or document the intent.

---

# Part 2 — Dependencies & Supply Chain

## ✅ Strong posture — DO NOT undo

This project's supply-chain hygiene is notably good. Preserve all of it:

- **`minimumReleaseAge: 1440`** (`pnpm-workspace.yaml`) — new package versions must be ≥24h old before install. This is a real defense against compromised-package "rug-pull"/worm attacks. Excellent.
- **`--frozen-lockfile`** in the deploy hook + committed `pnpm-lock.yaml` — reproducible installs.
- **`preinstall`** (`package.json:6`) enforces pnpm and deletes stray `package-lock.json`/`yarn.lock`.
- **`override: '@esbuild-kit/esm-loader' → npm:tsx`** — proactively replaces a deprecated transitive dep.
- **Pruned platform-binary optional deps** (the long `'-'` overrides) and **esbuild pinned to `0.27.3`**.
- Security-relevant deps are on current majors: `multer@^2` (1.x is deprecated/vuln — good you're on 2), `express@^5`, `helmet@^8`, `express-rate-limit@^8.3.1`, `passport@^0.7`, `file-type@^22`.

## 🟡 S1 — Build-script allowlist is fragmented across four disjoint sources

Install-script (postinstall) allowlisting — the control that stops a malicious dependency from running arbitrary code at install time — is currently spread across **four** files with **non-overlapping** entries:

| Source | Entries |
|---|---|
| `package.json` → `pnpm.onlyBuiltDependencies` | `sharp`, `protobufjs` |
| `pnpm-workspace.yaml` → `onlyBuiltDependencies` | `@swc/core`, `esbuild`, `msw`, `unrs-resolver` |
| `.pnpm-approved-builds.json` | `esbuild@0.27.3` |
| `.pnpm-build-config.json` | `sharp@0.33.5`, `protobufjs@7.5.4` |

**Problem.** It's unclear which is authoritative. pnpm reads `onlyBuiltDependencies` from **one** location; if the `pnpm-workspace.yaml` list wins, the `package.json` entries (`sharp`, `protobufjs`) may be ignored — and `sharp` has a native build. The `.pnpm-*.json` files look like Replit-generated or legacy-format artifacts that may no longer be consumed. Fragmentation makes the security control hard to audit and prone to drift.

**Fix.**
1. **Consolidate to one list** — put every package that legitimately needs a build script into `pnpm-workspace.yaml` → `onlyBuiltDependencies`:

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - esbuild
  - msw
  - unrs-resolver
  - sharp        # ADD (native image lib — confirm it needs a build)
  - protobufjs   # ADD
```

2. **Remove** the duplicate `pnpm.onlyBuiltDependencies` from `package.json` and the `.pnpm-approved-builds.json` / `.pnpm-build-config.json` files — *after* confirming the Replit build doesn't read them (grep the Replit build logs for those filenames).
3. **Verify `sharp` still loads** post-install (it ships prebuilt `@img/sharp-*` binaries on 0.33, so it may not need a script — but confirm image generation works after consolidating).

## 🟡 S2 — No `packageManager` / `engines` pinning

Neither the root nor any package pins the **pnpm version** (no corepack `packageManager` field) or the **Node version** in `engines`. Node is pinned only via `.replit` `modules = ["nodejs-24", ...]`, which doesn't govern CI or local dev.

**Fix — root `package.json`:**

```json
{
  "packageManager": "pnpm@10.x.y",          // pin to the version you deploy with
  "engines": { "node": ">=24 <25" }
}
```

This makes installs reproducible across Replit, CI, and local via corepack.

## 🟡 S4 — DB connection pool is unsized (ties to the deployment decision)

**Where.** `lib/db/src/index.ts`:

```ts
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

No `max` / `idleTimeoutMillis` — pg defaults to **`max: 10` per process**. On **autoscale**, that's `10 × instanceCount` connections, which can exhaust Postgres `max_connections` under fan-out. On a **Reserved VM** (single process), 10 is fine.

**Fix.**

```ts
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
```

If you stay on autoscale (Path B from the infra review), front Postgres with a pooler (PgBouncer / Neon pooled endpoint) and set a low per-instance `max`. On Reserved VM this is a non-issue — yet another simplification from choosing Path A.

## ⚪ S3 — Type-package nits

- Catalog pins **`@types/node: ^25`** (`pnpm-workspace.yaml`) while the runtime is **Node 24** (`.replit`). Types ahead of runtime can surface APIs not present at run time. Align to `^24`.
- **`@types/multer` is in `dependencies`** (`artifacts/api-server/package.json:13`) — type-only packages belong in `devDependencies`.

## ℹ️ S5 — Add automated vulnerability scanning

Manifest inspection shows current majors with no glaring known-vuln pins, and `minimumReleaseAge` is a strong *proactive* control — but neither catches a freshly-disclosed CVE in an existing dependency. Add `pnpm audit --prod` to CI (fail on high/critical) and/or enable Dependabot/Renovate. Low effort, ongoing value.

---

## Investigated — correct as-is / DO NOT change

- **`brands.name` / `brands.slug` unique** (`brands.ts:7-8`) and **`brand_schedule_profiles` unique index** on `(brand_id, platform, day_of_week, hour)` (`creatives.ts:151`) — uniqueness done right; leave them. (They show the pattern is known — D1 is the gap.)
- **FK cascade design** is mostly sound: `creatives.brand_id` cascade, `creative_variants`/`calendar_entries` cascade on parent, `social_account_id` set-null on delete. Keep.
- **`drizzle(pool, { schema })`** with the barrel schema (`lib/db/src/index.ts`) — correct (and consistent with excluding the orphaned tables, which D3 removes anyway).
- **All of the ✅ supply-chain posture** above.
- **Everything from the three prior review docs** (auth/RBAC, R1/R2, infra) still stands; nothing here reverses it.

---

## Suggested remediation order

**Phase 1 — safe, high-value, low-risk:**
1. **D3** — delete the orphaned `conversations`/`messages` schema files.
2. **D4** — reorder the scheduler index + narrow the failed-entries query.
3. **S2 / S3** — add `packageManager`/`engines`; fix the type-package nits.
4. **S5** — wire `pnpm audit` into CI.

**Phase 2 — needs a `push`/migration and testing:**
5. **D1** — de-dupe, add the unique index, convert to `ON CONFLICT`.
6. **D2** — `cost_usd` → `numeric`, tokens → `integer`, update the budget math; test the gate.
7. **S1** — consolidate the build-script allowlist; verify `sharp` builds.
8. **S4** — size the pg pool.

**Phase 3 — coordinate with Tony (process/modeling decisions):**
9. **M-A** — adopt `generate`/`migrate`, baseline `0000`, switch the deploy hook (closes infra M1).
10. **D5** — decide user-vs-brand ownership, add FKs/columns + backfill.
11. **D6 / D7** — enums/CHECKs and cosmetic renames.

---

## Verification checklist

- [ ] **D1:** inserting the same `(platform, account_id)` twice concurrently yields **one** row; reconnect updates in place.
- [ ] **D2:** `\d cost_logs` shows `cost_usd numeric(12,4)`; the budget reserve/settle gate still blocks at the ceiling (test with small budget).
- [ ] **D3:** `conversations`/`messages` files gone; typecheck + build pass; no code referenced them.
- [ ] **D4:** `EXPLAIN` on the scheduler's `publish_status='scheduled' AND scheduled_at<=now()` query uses `calendar_entries_status_schedule_idx` (index scan, not seq scan).
- [ ] **S1:** after consolidating, a clean `pnpm install --frozen-lockfile` succeeds and `sharp` image generation works.
- [ ] **S2:** `corepack` resolves the pinned pnpm; CI install is reproducible.
- [ ] **S4:** under load, total Postgres connections stay within `max_connections`.
- [ ] **M-A:** `pnpm --filter db migrate` applies cleanly from an empty DB to the current schema.

---

## When you're done — create a background task and push to GitHub

After you finish implementing the changes from this document, **create a background task and push the changes to the GitHub repository** (https://github.com/tonydye6/SparqMake), the same way you have for the previous review docs in this effort. This lets the work be verified against the pushed commit.

---

*Generated by an automated data-model & dependency review at commit `6e7fe4d`. Findings were confirmed by reading the schema files, `drizzle.config.ts`, the scheduler query path, and the pnpm/workspace manifests end-to-end. Schema changes that can fail on existing data are flagged inline — follow the step ordering. If a snippet doesn't match, search for the quoted code.*

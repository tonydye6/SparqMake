# SparqMake — Infrastructure & Deployment Review

**Repository:** https://github.com/tonydye6/SparqMake
**Reviewed at commit:** `599332b` ("Add daily budget check to image regeneration feature") — current `main`.
**Scope:** `.replit`, artifact configs (`artifact.toml`), the build pipeline, the server boot sequence, file/media storage, session/CORS/cookie/proxy posture, and secret handling.
**Predecessors:** Third doc in this effort, after *Backend Code Review & Remediation Guide* (`7123867`) and *Security Fix Verification & Follow-up Remediation* (`5b8cf12`). Those covered application-layer security; this one covers the platform the app runs on.
**Audience:** The Replit AI Agent implementing SparqMake.

---

## How to read this document

- **Severity:** 🔴 Critical → 🟠 High → 🟡 Medium → ⚪ Low.
- Every item cites `file:line` at commit `599332b`. Line numbers may drift as you edit — search for the quoted code if they don't match.
- Fixes are minimal and targeted. **Do not refactor beyond each fix.**
- **One decision gates the three biggest items (C1, C2, H1).** Read the next section first — it determines *how* you fix them. The Medium/Low items are safe to implement immediately regardless of that decision.

---

## The single root cause behind C1, C2, and H1

**SparqMake is written as one stateful, always-on server, but it is deployed to Replit Autoscale.**

`.replit:11` declares `deploymentTarget = "autoscale"`. Autoscale means three things the app does not currently assume:

1. **Ephemeral, per-instance filesystem** — each instance has its own disk; anything written at runtime is local to that instance and is wiped on recycle/redeploy.
2. **Horizontal fan-out** — multiple instances can run at once behind a load balancer; in-process state is not shared between them.
3. **Scale-to-zero** — when there's no inbound HTTP traffic, *all* instances are torn down, so no background process runs.

The app, however, stores media on local disk, runs its publish scheduler with an in-process `setInterval`, and rate-limits using an in-memory store. Those are all correct for a *single long-lived box* and broken on *autoscale*.

### You have two coherent paths. Pick one before touching C1/C2/H1.

| | **Path A — Reserved VM (recommended)** | **Path B — stay on Autoscale, re-architect** |
|---|---|---|
| What it is | Switch `deploymentTarget` to a single always-on Reserved VM with a persistent disk | Make the app stateless: object storage + external scheduler + shared rate-limit store |
| Effort | **One config change** (flip the deployment type) | Substantial — touches storage, publishing, and rate-limiting code |
| Closes | **C1, C2, and H1 at once** | C1, C2, H1 individually, with real code changes |
| Cost model | Always-on (flat monthly), no scale-to-zero | Pay-per-use, scales to zero |
| Choose when | Default. You don't need horizontal scale-out today. | You genuinely need to scale out under bursty load |

> **DECISION REQUIRED — get Tony's sign-off before implementing C1/C2/H1.** This is a deployment-model/billing change, not a pure code fix. Reserved VM is always-on (flat cost); Autoscale scales to zero (pay-per-use). **Do not flip the deployment target on your own.** Once Tony confirms the path, implement the matching column below.

**Everything in the Medium/Low section is path-independent — implement it now regardless of the decision.**

---

## At-a-glance

| # | Sev | Finding | Anchor at `599332b` | Resolved by |
|---|-----|---------|---------------------|-------------|
| C1 | 🔴 | Media stored on local disk; lost/unavailable on ephemeral autoscale FS | `upload.ts:10`, `video.ts:22`, `download.ts:15`, `brands.ts:34-36` | Path A or B |
| C2 | 🔴 | In-process `setInterval` publish scheduler dies on scale-to-zero | `publish-scheduler.ts:374`, `index.ts:26` | Path A or B |
| H1 | 🟠 | In-memory rate-limit store is per-instance; weakens the #6 hardening | `rate-limit.ts:3-15` | Path A or B |
| M1 | 🟡 | Deploy hook runs destructive `drizzle-kit push` | `scripts/post-merge.sh:4` | Path-independent |
| M2 | 🟡 | `seedDatabase()` + `refreshExpiringTokens()` race on every instance boot | `index.ts:21,26,31`, `seed.ts:213-218` | Path-independent (moot under A) |
| M3 | 🟡 | `.env` and `uploads/` not git-ignored | `.gitignore` | Path-independent |
| L1 | ⚪ | Demo brands seeded into a production DB on first empty boot | `seed.ts:213-234` | Path-independent |
| L2 | ⚪ | `NODE_ENV` not set in artifact run env (mitigated by build define) | `artifact.toml:21-22` | Path-independent |

---

## 🔴 C1 — Generated/uploaded media lives on an ephemeral, per-instance disk

**Where.** All media is read/written on the local filesystem under `process.cwd()/uploads`:

- `artifacts/api-server/src/routes/upload.ts:10` — `const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");`
- `artifacts/api-server/src/routes/video.ts:22` — `const UPLOADS_DIR = path.resolve(process.cwd(), "uploads", "generated");` (rendered video written here)
- `artifacts/api-server/src/routes/download.ts:15` — reads back from the same `uploads/generated`
- `artifacts/api-server/src/routes/brands.ts:34-36` — `multer.diskStorage({ … path.join(UPLOADS_DIR, "brand-assets") })`

There is **no object storage anywhere** in the codebase (no `@replit/object-storage`, `@aws-sdk/*`, or `@google-cloud/storage` dependency).

**Why it breaks on autoscale.**

1. **Files vanish.** A redeploy or instance recycle wipes everything written since boot. Generated images/videos and brand-asset uploads disappear.
2. **Files aren't shared.** A file written by instance A does not exist on instance B. With ≥2 instances, reads are a coin flip.
3. **Byte-upload publishing fails.** Twitter/LinkedIn/YouTube/TikTok-video publish by `readFileSync`-ing the local file and uploading bytes. If the file was written by a now-gone or different instance, the read throws and the post fails.
4. **The R1 fix from the previous doc is necessary but not sufficient here.** Making `GET /api/files/generated/:filename` public lets Instagram (`image_url`) and TikTok-photo (`PULL_FROM_URL`) *attempt* the pull — but the load balancer can route that anonymous pull to an instance that never had the file → `404` → publish fails. R1 fixed the auth problem; it cannot fix the "the bytes aren't on this instance" problem.

### Path A fix (recommended) — Reserved VM with a persistent disk

On a Reserved VM there is exactly one instance with a stable disk, so the existing local-disk code is correct as-is. **No application code changes for C1.** You only flip the deployment type (see the shared "Switch to Reserved VM" steps under C2 — do it once; it covers C1, C2, and H1).

> Confirm the `uploads/` directory persists across redeploys on the Reserved VM (Replit Reserved VMs keep the filesystem across restarts). If your plan's disk is not persistent, fall back to Path B for storage.

### Path B fix — move media to object storage

Only if you stay on Autoscale. Shape of the change (do **not** also refactor unrelated code):

1. Add **Replit Object Storage** (`@replit/object-storage`) — or S3/GCS — as the media backend.
2. **`upload.ts` / `brands.ts`:** swap `multer.diskStorage` for `multer.memoryStorage()` and upload the buffer to the bucket under the same UUID key. Keep `validateUploadedFile` magic-byte checks (run them on the buffer via `validateUploadedBuffer`).
3. **`video.ts`:** after rendering to a temp path, upload the file to the bucket, then delete the temp file.
4. **Serving (`upload.ts` `serveFile`, `download.ts`):** stream the object from the bucket, or 302-redirect to a signed/public object URL. Keep the public-vs-authed split from R1 (`generated` public; raw uploads + brand-assets authed).
5. **Byte-upload publishers** (`publish-twitter/linkedin/youtube`, TikTok-video): download the object to a temp file (or get a buffer) instead of `readFileSync` on local disk.
6. **URL-pull publishers** (Instagram, TikTok-photo): point them at the public object URL.

This is a large change touching ~8 files. **Path A avoids all of it** — prefer it unless scale-out is a hard requirement.

---

## 🔴 C2 — The publish scheduler is an in-process timer that dies when the app is idle

**Where.**
- `artifacts/api-server/src/services/publish-scheduler.ts:374` — `intervalId = setInterval(pollAndPublish, POLL_INTERVAL_MS);`
- `artifacts/api-server/src/index.ts:26` — `startPublishScheduler()` is called from inside `app.listen(...)`, i.e. it only exists while *this process* is alive.

**Why it breaks on autoscale.**

- **Scale-to-zero is fatal for a scheduler.** Autoscale tears down every instance when there's no HTTP traffic. With no process, the `setInterval` never fires. For a *scheduled social-posting product*, this means **scheduled posts silently do not go out** until some unrelated request happens to wake an instance. This is the most user-visible failure mode in the whole review.
- **Multiple instances = multiple pollers.** With N instances up, you get N concurrent pollers. Double-posting is currently prevented by the transactional claim inside `publishEntry` (good), but it's wasteful and racy. The `if (intervalId)` guard at `publish-scheduler.ts:368` only de-dupes *within a single process*, not across instances.

### Path A fix (recommended) — Reserved VM keeps one process always alive

A Reserved VM runs one instance continuously and never scales to zero, so the in-process `setInterval` runs forever as intended. **No application code changes for C2.** Covered by the same deployment-type flip below.

### Path B fix — external scheduler

Only if you stay on Autoscale:

1. Extract `pollAndPublish` into a standalone entrypoint (a small script that imports `pollAndPublish`, runs it once, and exits).
2. Run it on a **Replit Scheduled Deployment** (cron) every minute — *or* expose an internal, authenticated `POST /api/internal/run-scheduler` and have the scheduled deployment hit it.
3. Remove the in-process `setInterval` boot call (`index.ts:26`) so the web instances don't also poll.

### Switch to Reserved VM (the Path A action that closes C1 + C2 + H1)

1. In the Replit **Deployments** pane, change the deployment type from **Autoscale** to **Reserved VM**. Let the UI write the new `deploymentTarget` into `.replit` — **do not hand-edit the token string**, because Replit's exact value for Reserved VM has changed over time (historically `"gce"`). The UI is authoritative.
2. Commit the resulting `.replit`. The diff should be only the `[deployment]` block:

```toml
# .replit  — BEFORE (lines 9-11)
[deployment]
router = "application"
deploymentTarget = "autoscale"
```

```toml
# .replit  — AFTER (value written by the Deployments UI; shown for reference only)
[deployment]
router = "application"
deploymentTarget = "gce"   # ← whatever the "Reserved VM" option writes; verify in Replit Deployments docs, do not guess
```

3. Provision a Reserved VM size with a **persistent disk** so `uploads/` survives restarts (confirms C1).
4. Redeploy and run the verification checklist below.

> This single switch makes C1, C2, and H1 disappear without code changes. That's why it's the recommended path.

---

## 🟠 H1 — The rate limiter counts per-instance, diluting the #6 abuse protection

**Where.** `artifacts/api-server/src/lib/rate-limit.ts:3-15`:

```ts
export const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res): string => { /* user:<id> or ip:<addr> */ },
  message: { error: "Too many generation requests, please wait before trying again." },
});
```

There is **no `store:` option**, so `express-rate-limit` falls back to its default in-memory `MemoryStore` — **one counter per instance.**

**Why it matters.** On autoscale the load balancer can spray a single user's bursts across instances, so the effective ceiling becomes `max × instanceCount` (e.g. 5 → 5×N per window). This dilutes exactly the generation rate-limit we hardened in the previous doc (#6 / R2).

> Note: the **DB-backed budget reservation** added in `generate.ts` (the `pg_advisory_xact_lock` + `cost_logs` reserve/settle) *does* hold across instances, so total spend is still capped. H1 weakens the *request-rate* gate, not the dollar ceiling. Still worth closing.

### Path A fix (recommended)
A Reserved VM is a single instance, so one `MemoryStore` is the *only* store — the limiter behaves exactly as configured. **No code change.** Closed by the deployment-type flip.

### Path B fix — shared store
Only if you stay on Autoscale: configure a shared store so all instances share counters. You already run Postgres, so a PG-backed store avoids adding Redis:

```ts
// rate-limit.ts — Path B sketch
import rateLimit from "express-rate-limit";
import PostgresStore from "@acpr/rate-limit-postgresql"; // or rate-limit-redis if you add Redis

export const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: new PostgresStore(/* reuse the existing pg pool / connection string */),
  // …keyGenerator, message unchanged
});
```

Validate the chosen store adapter against your Postgres/Drizzle setup before shipping.

---

## 🟡 M1 — The deploy hook force-syncs the schema with `drizzle-kit push` (path-independent)

**Where.** `scripts/post-merge.sh:4`:

```bash
#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push        # ← drizzle-kit push: diffs the schema and force-applies, can DROP/ALTER columns
```

**Problem.** `drizzle-kit push` introspects the live DB and force-applies whatever the schema files imply — it can silently drop or alter columns on drift. You *also* maintain versioned migrations (e.g. `lib/db/drizzle/0007_add_cost_logs_indexes.sql`), so mixing `push` (dev-style, stateful-diff) with committed migrations is inconsistent and risky in production: `push` can clobber or diverge from what your migration history created.

**Fix — run migrations, not push, in the deploy hook:**

```bash
#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db migrate     # apply committed migrations deterministically
```

Make sure the `db` package exposes a `migrate` script that runs `drizzle-kit migrate` (or `drizzle-orm/<driver>/migrator`) against `lib/db/drizzle`. Keep `push` for local dev only. Do not change the schema files themselves.

---

## 🟡 M2 — Boot-time `seed` + `token refresh` race across instances (path-independent; moot under Path A)

**Where.** `artifacts/api-server/src/index.ts`:

```ts
seedDatabase()                       // line 21 — runs on every instance boot
  .then(() => {
    app.listen(port, () => {
      startPublishScheduler();       // line 26
    });
    refreshExpiringTokens()          // line 31 — runs on every instance boot
      .then(...).catch(...);
  })
```

And `seed.ts:213-218` — the idempotency guard is a plain read-then-write, **not** transactionally locked:

```ts
export async function seedDatabase() {
  const existingBrands = await db.select({ id: brandsTable.id }).from(brandsTable);
  if (existingBrands.length > 0) { /* skip */ return; }
  // …inserts DEFAULT_BRANDS
```

**Problem (autoscale only).** When several instances boot at once on an empty DB, two can both pass the `existingBrands.length > 0` check and both insert `DEFAULT_BRANDS` → duplicate brands. Likewise `refreshExpiringTokens()` runs on every instance, so N instances race to refresh the same OAuth tokens → redundant refreshes / possible token invalidation.

**Fix.**
- **Under Path A (Reserved VM): this is moot** — a single instance boots once. No change needed.
- **Under Path B (Autoscale):** guard both with a Postgres advisory lock (you already use `pg_advisory_xact_lock` in `generate.ts` — reuse the pattern with a distinct key), or make the seed insert idempotent via `ON CONFLICT (slug) DO NOTHING` on a unique `brands.slug`. Move `refreshExpiringTokens()` out of per-instance boot and into the single external scheduler from C2/Path B.

---

## 🟡 M3 — `.env` and `uploads/` are not git-ignored (path-independent)

**Where.** `.gitignore` ignores `dist`, `node_modules`, `.DS_Store`, `.cache/`, `.local/` — but **not** `.env` or `uploads/`. A stray `.env` or locally-written upload can be committed by accident (a real secret-leak / repo-bloat risk).

**Fix — append to `.gitignore`:**

```gitignore
# Secrets
.env
.env.*
!.env.example

# Local runtime uploads (never commit user/generated media)
uploads/
```

If anything sensitive was ever committed, rotate it; `.gitignore` does not remove already-tracked files.

---

## ⚪ L1 — Demo brands seed into production (path-independent)

`seed.ts:213-234` inserts `DEFAULT_BRANDS` (e.g. "Crown U", "Rumble U", "Mascot Mayhem", "corporate") whenever the DB has zero brands — including a fresh **production** database. That pollutes prod with demo content.

**Fix — gate demo seeding behind an explicit flag** so prod starts clean:

```ts
export async function seedDatabase() {
  if (process.env.SEED_DEMO_DATA !== "true") {
    console.log("SEED_DEMO_DATA not set; skipping demo seed.");
    return;
  }
  const existingBrands = await db.select({ id: brandsTable.id }).from(brandsTable);
  if (existingBrands.length > 0) { return; }
  // …unchanged
}
```

Set `SEED_DEMO_DATA=true` only in `[userenv.development]`. Leave it unset in production.

---

## ⚪ L2 — `NODE_ENV` not set in the artifact run env (path-independent)

`artifacts/api-server/.replit-artifact/artifact.toml:21-22` sets only `PORT`:

```toml
[services.production.run.env]
PORT = "8080"
```

This is **currently harmless** — `build.ts` bakes `process.env.NODE_ENV = "production"` into the bundle via esbuild `define`, so app-code prod checks (secure cookies, CORS) already evaluate correctly. But any dependency that reads `NODE_ENV` from the *real* process env at runtime (not the inlined copy) would see it unset. Cheap defense-in-depth:

```toml
[services.production.run.env]
PORT = "8080"
NODE_ENV = "production"
```

---

## Investigated — DO NOT change (correct as-is; changing these would regress security)

- **PG-backed session store** — `lib/session.ts:36` uses `connect-pg-simple`, so sessions are shared across instances and survive recycles. Keep it (this is the one piece already built for multi-instance).
- **`trust proxy: 1`** + `secure`/`httpOnly`/`sameSite=lax` cookies, `rolling`, 30-day maxAge, `SESSION_SECRET` required in prod. Correct behind Replit's proxy. Leave alone.
- **Build bakes `NODE_ENV=production`** via esbuild `define` in `build.ts`. Do not remove (L2 is additive, not a replacement).
- **pnpm install-script allowlist** (`.pnpm-approved-builds.json`, `.pnpm-build-config.json`) — good supply-chain posture. Keep.
- **`/api/healthz`** matches the startup probe in `artifact.toml:24-25`. Keep.
- **CORS** — `lib/allowed-origins.ts` is env-driven, no wildcards, localhost only outside production. Keep.
- **`PORT` required + validated** at `index.ts:7-19`. Keep.
- **`.env.example`** — documents required vars with no real secrets. Keep.
- **R1 / R2 fixes** from the previous doc (public `/files/generated` route, `generationLimiter` + budget reservation on `regenerate`). Keep — C1/H1 here are the *infra* counterparts, not a reversal.

---

## Suggested remediation order

**Phase 0 — decision (Tony).** Choose Path A (Reserved VM, recommended) or Path B (re-architect for autoscale). Nothing in C1/C2/H1 ships until this is settled.

**Phase 1 — path-independent hardening (do now, no sign-off needed):**
1. **M1** — `post-merge.sh`: `push` → `migrate`.
2. **M3** — add `.env` / `uploads/` to `.gitignore`.
3. **L1** — gate demo seed behind `SEED_DEMO_DATA`.
4. **L2** — add `NODE_ENV="production"` to the artifact run env.

**Phase 2 — the architecture fix (after Phase 0 sign-off):**
- **Path A:** flip to Reserved VM via the Deployments UI, ensure persistent disk, redeploy. Closes **C1 + C2 + H1**. M2 becomes moot.
- **Path B:** object storage (C1) + external scheduler (C2) + shared rate-limit store (H1) + boot-race guards (M2).

---

## Verification checklist

After Phase 1 (both paths):
- [ ] A merge/deploy runs `drizzle-kit migrate` (not `push`) — confirm in the deploy log.
- [ ] `git check-ignore .env uploads/somefile.png` → both report ignored.
- [ ] Fresh **production** boot creates **zero** demo brands (with `SEED_DEMO_DATA` unset).
- [ ] `NODE_ENV` is `production` in the running container env.

After Phase 2 — **Path A (Reserved VM):**
- [ ] Generate an image, then **redeploy**, then fetch it again → still `200` (survives recycle).
- [ ] Schedule a post for ~2 min out, leave the app with **no traffic**, confirm it still publishes on time (scheduler stayed alive).
- [ ] Fire 6 generation requests in 60s → the 6th returns `429` (single-instance limiter intact).
- [ ] Instagram + TikTok-photo posts reach `published` (R1 URL resolves and the bytes are present).

After Phase 2 — **Path B (Autoscale):**
- [ ] Upload on one request, fetch on another under load → always `200` (object storage shared).
- [ ] Scheduled post publishes while all web instances are scaled to zero (external scheduler fired).
- [ ] 6 generation requests spread across instances → 6th still `429` (shared store).

---

## When you're done — create a background task and push to GitHub

After you finish implementing the changes from this document, **create a background task and push the changes to the GitHub repository** (https://github.com/tonydye6/SparqMake), the same way you have for the previous review docs in this effort. This lets the work be verified against the pushed commit.

---

*Generated by an automated infrastructure review at commit `599332b`. Every finding was confirmed by reading the deployment config and execution paths end-to-end; none of the infra files changed across the prior security-fix commits, so these anchors are current. If a snippet doesn't match, search for the quoted code. The Reserved-VM `deploymentTarget` token is intentionally not hard-coded — set it via the Replit Deployments UI, which is authoritative.*

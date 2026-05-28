# SparqMake — Backend Code Review & Remediation Guide

**Repository:** https://github.com/tonydye6/SparqMake
**Reviewed at commit:** `7123867` ("Improve security, fix calendar date handling, and refine upload functionality")
**Scope:** Backend — `artifacts/api-server/src` (Express 5 API), `lib/db` (Drizzle schema), `lib/api-zod` (Zod request schemas)
**Areas covered:** (1) Auth & access control, (2) File handling & SSRF, (3) Data layer & validation, (4) AI generation & publishing
**Audience:** The Replit AI Agent implementing SparqMake. Each finding has a concrete before/after fix. Apply in the order given in **§ Suggested Remediation Order**.

---

## How to read this document

- **Severity:** 🔴 Critical → 🟠 High → 🟡 Medium → ⚪ Low.
- Every finding cites `file:line` at the reviewed commit. Line numbers may drift as you edit — search for the quoted code if they don't match.
- **§ Investigated — DO NOT "fix" these** lists things that look like bugs but are correct by design. Do not change them; doing so would introduce regressions.
- Fixes are minimal and targeted. Do not refactor surrounding code beyond what each fix requires.

---

## The access-control model (read this first — it frames everything)

SparqMake is a **single-workspace, role-and-brand-scoped** app, **not** a per-user multi-tenant app:

- `usersTable` has a `role` column (`viewer` / `editor`), defaulting to `viewer`.
- Data is scoped by **brand** (`brandId`), not by user. `createdBy` / `reviewedBy` are **audit** fields, not access boundaries.
- All `/api` routes (except `/api/auth/*` and `/api/health`) sit behind `requireAuth` (`app.ts:119`).

That design is fine. The problem is that **two pillars the design depends on are missing**, and almost every Critical/High finding below is a direct consequence:

1. **There is no gate on _who can log in_** — any Google account self-provisions an account (Critical #1).
2. **The `role` column is never enforced anywhere** — every authenticated user has full power (Critical #2).

So today the *entire* security boundary of the application is: **"Do you possess any Google account?"** — which everyone does. Fixing #1 and #2 shrinks the blast radius of nearly everything else.

---

## Executive Summary

The backend is well-structured: Zod-validated inputs on most routes, AES-256-GCM encryption of stored OAuth tokens, an Origin/Referer CSRF allow-list, parameterized Drizzle queries, UUID primary keys, sensible rate-limit scaffolding, and a sound publish-retry state machine. Credit where due — see **§ What Looks Good**.

However, the **authorization layer is effectively absent**. Authentication is implemented; authorization is not. Combined with **open self-registration**, any person on the internet can: sign in, read/modify/delete every brand's data, connect and **publish to any connected social account**, delete an entire brand (cascading to all its content), and run **unbounded paid AI generation**. These are not theoretical — each is traced to specific code below and was verified by reading the execution path end-to-end.

**Verdict: 🔴 Request Changes.** Ship the four Criticals before any production/multi-user exposure. The app is reasonably safe only if every person who can authenticate is fully trusted (i.e., a tiny private deployment); it is not safe for any broader audience.

---

## 🔴 Critical Issues

| # | Title | File:Line | Impact |
|---|-------|-----------|--------|
| 1 | Open registration — any Google account becomes an `editor` | `lib/passport.ts:108` | Anyone on the internet gains full app access |
| 2 | `role` column is never enforced (no RBAC) | `middleware/auth.ts:88` (+ everywhere) | Every authenticated user can do everything |
| 3 | Cross-brand publishing — no brand check on publish path | `routes/calendar-entries.ts:75`, `services/publish-scheduler.ts:100` | Any user posts any content to any connected social account |
| 4 | `DELETE /brands/:id` wipes a brand + all data, no guard | `routes/brands.ts:82` | Any user irreversibly destroys an entire brand via FK cascade |

---

### 🔴 1 — Open registration: any Google account is auto-provisioned as `editor`

**`artifacts/api-server/src/lib/passport.ts:77-128`** (the Google verify callback)

There is **no email allow-list, no domain restriction, no Google `hd` (hosted-domain) parameter, and no `email_verified` check** anywhere in the codebase (confirmed by grep across `artifacts/api-server/src` and `lib`). The verify callback takes whatever email Google returns and, if no user exists, **creates one with `role: "editor"`**:

```ts
// passport.ts:108-116  (CURRENT)
const [newUser] = await db
  .insert(usersTable)
  .values({
    email,
    name: profile.displayName || email,
    image: profile.photos?.[0]?.value || null,
    role: "editor",          // <-- every new sign-in becomes an editor
  })
  .returning();
```

Anyone with any Google account who hits "Sign in with Google" becomes a full editor. There is no approval step.

**Fix** — gate provisioning behind an env-configured allow-list, and default new users to `viewer`:

```ts
// passport.ts — add near the top
function isEmailAllowed(email: string): boolean {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const emails = (process.env.ALLOWED_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const lower = email.toLowerCase();
  if (emails.includes(lower)) return true;
  const domain = lower.split("@")[1] ?? "";
  return domains.includes(domain);
}

// inside the verify callback, right after you resolve `email`:
const email = profile.emails?.[0]?.value;
const emailVerified = (profile.emails?.[0] as any)?.verified ?? true; // Google sets this
if (!email || !emailVerified) { done(null, false); return; }
if (!isEmailAllowed(email)) {
  logger.warn({ email }, "Rejected login: email not in allow-list");
  done(null, false);   // Passport treats `false` as auth failure
  return;
}

// and when creating a new user, default to least privilege:
.values({ email, name: profile.displayName || email, image: ..., role: "viewer" })
```

Set `ALLOWED_EMAIL_DOMAINS=sparqgames.com` (and/or `ALLOWED_EMAILS=...`) in the Replit secrets. Promote specific users to `editor`/`admin` deliberately (DB update or an admin endpoint). **Pair this with #2** — an allow-list limits *who gets in*; roles limit *what they can do*.

---

### 🔴 2 — The `role` column is never enforced (no RBAC anywhere)

**`artifacts/api-server/src/middleware/auth.ts:88-100`** — `requireAuth` checks only `req.isAuthenticated() && req.user`. There is **no `requireRole` middleware** (the only middleware files are `auth.ts`, `csrf.ts`, `validate.ts`), and **no route ever reads `req.user.role`**. (Every `.role` reference in `routes/` is about *asset* roles — `"primary"`, `"style_reference"` — unrelated to user RBAC.)

So `usersTable.role` is decorative: a `viewer` can do everything an `editor` can, including all destructive operations below.

**Fix** — add a role middleware and apply it. First, the middleware:

```ts
// middleware/auth.ts — add
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };
export function requireRole(min: "viewer" | "editor" | "admin") {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req.user as Express.User | undefined)?.role ?? "viewer";
    if ((ROLE_RANK[role] ?? 0) >= ROLE_RANK[min]) return next();
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}
```

Then enforce it. The pragmatic, low-churn pattern is to require `editor` for any state-changing method on the main router, and `admin` for the few truly destructive endpoints:

```ts
// app.ts — replace the main mount (line 119)
// 1) Block writes from viewers globally:
app.use("/api", requireAuth, (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  return requireRole("editor")(req, res, next);
}, router);
```

```ts
// then gate the destructive ones explicitly inside their routers, e.g. brands.ts:
router.delete("/brands/:id", requireRole("admin"), validateRequest({ params: DeleteBrandParams }), handler);
```

Apply `requireRole("admin")` to at least: `DELETE /brands/:id`, `DELETE /social-accounts/:id`, `DELETE /templates/:id` (see #4, #7, #8). You'll need a way to mint an `admin` — promote your own account via a one-off DB update.

> **Note:** introduce `"admin"` as a valid role value. `usersTable.role` is a free `text` column today, so no migration is strictly required, but consider a CHECK constraint (`viewer|editor|admin`) — see Medium findings.

---

### 🔴 3 — Cross-brand publishing: any user can post any content to any connected social account

**`artifacts/api-server/src/routes/calendar-entries.ts:75-87` and `:122-161`; `services/publish-scheduler.ts:100-152`**

`POST /calendar-entries` validates the *shape* of the body but never checks that the supplied IDs are consistent with each other:

```ts
// calendar-entries.ts:75  (CURRENT)
router.post("/calendar-entries", validateRequest({ body: CreateCalendarEntryBody }), async (req, res) => {
  const { creativeId, variantId, platform, scheduledAt, socialAccountId } = req.body;
  const [entry] = await db.insert(calendarEntriesTable).values({
    creativeId, variantId, platform,
    scheduledAt: new Date(scheduledAt),
    socialAccountId: socialAccountId || null,   // <-- no check that this account's brand == creative's brand
  }).returning();
  res.status(201).json(entry);
});
```

`publishEntry` (the actual poster) only verifies the **platform type** matches — never the **brand**:

```ts
// publish-scheduler.ts:115-134  (CURRENT) — platform check only, no brand check
const expectedPlatform = platformMap[entry.platform] || entry.platform;
if (socialAccount.platform !== expectedPlatform && socialAccount.platform !== entry.platform) { /* fail */ }
// ... it never loads the creative, never compares socialAccount.brandId to creative.brandId
```

**Exploit:** any authenticated user creates a calendar entry pairing *any* brand's creative variant (attacker-chosen caption + image) with *any* connected social account, calls `/publish`, and the content goes live on that account. Layered on #1+#2, a self-registered stranger can post arbitrary content to **every** connected Instagram/LinkedIn/TikTok/X/YouTube account in the system.

**Fix** — enforce brand consistency at write time and again at publish time (defense in depth). At creation:

```ts
// calendar-entries.ts — inside POST /calendar-entries, before insert
const [creative] = await db.select({ brandId: creativesTable.brandId })
  .from(creativesTable).where(eq(creativesTable.id, creativeId));
if (!creative) { res.status(400).json({ error: "Creative not found" }); return; }

const [variant] = await db.select({ creativeId: creativeVariantsTable.creativeId })
  .from(creativeVariantsTable).where(eq(creativeVariantsTable.id, variantId));
if (!variant || variant.creativeId !== creativeId) {
  res.status(400).json({ error: "Variant does not belong to creative" }); return;
}

if (socialAccountId) {
  const [acct] = await db.select({ brandId: socialAccountsTable.brandId })
    .from(socialAccountsTable).where(eq(socialAccountsTable.id, socialAccountId));
  if (!acct) { res.status(400).json({ error: "Social account not found" }); return; }
  if (acct.brandId && acct.brandId !== creative.brandId) {
    res.status(403).json({ error: "Social account belongs to a different brand" }); return;
  }
}
```

And the authoritative check inside `publishEntry` (after it loads `socialAccount` and `variant`, ~`publish-scheduler.ts:136`):

```ts
const [creative] = await tx.select({ brandId: creativesTable.brandId })
  .from(creativesTable).where(eq(creativesTable.id, entry.creativeId));
if (!creative || (socialAccount.brandId && socialAccount.brandId !== creative.brandId)) {
  await tx.update(calendarEntriesTable).set({
    publishStatus: "failed", publishError: "Brand mismatch between account and creative",
    retryCount: (entry.retryCount || 0) + 1, updatedAt: new Date(),
  }).where(eq(calendarEntriesTable.id, entryId));
  return null;
}
```

---

### 🔴 4 — `DELETE /brands/:id` destroys a brand and all its data, with no authorization

**`artifacts/api-server/src/routes/brands.ts:82-90`**

```ts
// brands.ts:82  (CURRENT)
router.delete("/brands/:id", validateRequest({ params: DeleteBrandParams }), async (req, res) => {
  const [brand] = await db.delete(brandsTable).where(eq(brandsTable.id, req.params.id)).returning();
  ...
});
```

Per the FK schema, `brandId` is `onDelete: "cascade"` on `creatives` → which cascades to `creative_variants` → `calendar_entries`, plus `assets`, `templates`, `hashtag_sets`. **One request from any self-registered user irreversibly deletes an entire brand and everything ever created under it.** There is no soft-delete, no confirmation, no role check.

**Fix** — gate behind `admin` (from #2) and, ideally, soft-delete instead of hard-delete:

```ts
// brands.ts:82  (FIXED — minimum: require admin)
router.delete("/brands/:id", requireRole("admin"), validateRequest({ params: DeleteBrandParams }), async (req, res) => {
  // Prefer a soft delete to make this recoverable:
  const [brand] = await db.update(brandsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(brandsTable.id, req.params.id)).returning();
  if (!brand) { res.status(404).json({ error: "Brand not found" }); return; }
  res.json(DeleteBrandResponse.parse({ message: "Brand deactivated" }));
});
```

If a hard delete is genuinely required, keep it `admin`-only and require an explicit confirmation token in the request. (`brandsTable.isActive` already exists — `schema/brands.ts:25` — so most read paths can filter on it.)

---

## 🟠 High Issues

| # | Title | File:Line | Category |
|---|-------|-----------|----------|
| 5 | Self-approval / review-workflow bypass via mass-assignment | `routes/creatives.ts:113`, `api-zod:613` | Access control |
| 6 | Unbounded paid AI generation (financial DoS) | `app.ts:64,114`, `routes/video.ts:35`, `routes/rewrite.ts:14`, `routes/generate.ts:670` | Abuse / cost |
| 7 | `DELETE`/`refresh` social accounts — ungated DoS on social presence | `routes/social-accounts.ts:76,96` | Access control |
| 8 | `DELETE /templates/:id` — ungated destructive op | `routes/templates.ts:95` | Access control |
| 9 | Mass-assignment on `PUT /content-plan/:id` (no schema) | `routes/content-plan.ts:221` | Validation |
| 10 | Arbitrary global-settings write disables budget cap | `routes/settings.ts:7,20` | Validation / abuse |
| 11 | ffmpeg filtergraph injection via unvalidated volume params | `routes/video.ts:180`, `services/audio-merge.ts:50` | Injection |

---

### 🟠 5 — Self-approval & arbitrary status via `PUT /creatives/:id` mass-assignment

**`routes/creatives.ts:113-118`** spreads the request body straight into the update, and the schema **`lib/api-zod/src/generated/api.ts:613` (`UpdateCreativeBody`)** whitelists `status`, `reviewedBy`, and `reviewComment` as free-form client-settable fields:

```ts
// api.ts:613
export const UpdateCreativeBody = zod.object({
  name: zod.string().optional(),
  status: zod.string().optional(),       // <-- not an enum; "approved" accepted
  ...
  reviewedBy: zod.string().nullish(),    // <-- client sets the reviewer
  reviewComment: zod.string().nullish(),
});

// creatives.ts:113
.set({ ...req.body, updatedAt: new Date() })   // <-- writes status/reviewedBy verbatim
```

Any user can `PUT /creatives/:id {"status":"approved","reviewedBy":"anyone","reviewComment":"lgtm"}` and self-approve, bypassing the variant-level review workflow. `status` being unconstrained also lets arbitrary garbage land in the column.

**Fix** — remove workflow/audit fields from the client-editable schema and constrain `status` to an enum. Set approval state only via a dedicated, role-gated review endpoint.

```ts
// api.ts — UpdateCreativeBody (FIXED): drop reviewedBy/reviewComment, constrain status
export const UpdateCreativeBody = zod.object({
  name: zod.string().optional(),
  status: zod.enum(["draft", "in_review", "ready"]).optional(), // no client-settable "approved"
  briefText: zod.string().nullish(),
  referenceUrl: zod.string().nullish(),
  templateId: zod.string().nullish(),
  selectedAssets: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
  selectedHashtagSets: zod.array(zod.string()).nullish(),
});
```

```ts
// new dedicated endpoint, role-gated, that stamps the reviewer server-side
router.post("/creatives/:id/review", requireRole("editor"),
  validateRequest({ params: IdParams, body: z.object({ decision: z.enum(["approved","rejected"]), comment: z.string().optional() }) }),
  async (req, res) => {
    const [c] = await db.update(creativesTable).set({
      status: req.body.decision,
      reviewedBy: (req.user as Express.User).id,   // server-stamped, not client
      reviewComment: req.body.comment ?? null,
      reviewedAt: new Date(), updatedAt: new Date(),
    }).where(eq(creativesTable.id, req.params.id)).returning();
    if (!c) { res.status(404).json({ error: "Creative not found" }); return; }
    res.json(c);
  });
```

---

### 🟠 6 — Unbounded paid AI generation (financial denial-of-service)

Generation calls cost real money (Imagen, Claude, ElevenLabs, VEO video). The controls are incomplete:

1. **The generation rate limiter is per-IP and mounted before auth.** `generationLimiter` (`app.ts:64`) has no `keyGenerator`, so express-rate-limit defaults to `req.ip`. With `trust proxy: 1`, that's the forwarded client IP — so it's per-IP (sharable behind NAT; bypassable by rotating IPs), not per-user. Worse, it's mounted at `app.ts:114-117`, **before** `requireAuth` (`app.ts:119`), so `req.user` isn't even populated there.
2. **Several paid endpoints have no generation limiter at all:** `POST /creatives/:id/variants/:variantId/regenerate` (`generate.ts:670`, paid Imagen), `POST /rewrite` (`rewrite.ts:14`, Claude), `POST /brands/:brandId/schedule-profile/generate` (`schedule-profile.ts:133`, up to 5 Claude calls/request), `POST /creatives/:id/generate-video` is limited but video is the most expensive call.
3. **The daily budget is global and optional.** The `dailyCostThreshold` check exists only in `generate.ts:180-223`; it sums **all** `cost_logs` rows (`generate.ts:194`) with no per-user attribution (there's no `userId` on `cost_logs`), and only runs if an admin set a threshold > 0.

Layered on open registration (#1), a stranger can drive unbounded paid spend.

**Fix** — (a) key the limiter on the authenticated user and mount it after auth; (b) add the missing endpoints to it; (c) extend the budget reservation to all paid paths.

```ts
// app.ts — define an authed, per-user generation limiter and mount AFTER requireAuth
const generationLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req.user as Express.User | undefined)?.id ?? req.ip,
  message: { error: "Too many generation requests, please wait." },
});

// remove the four app.use(...generationLimiter) lines at 114-117, and instead
// apply the limiter inside the main authed router (where req.user exists), e.g.
app.use("/api", requireAuth, router);   // and attach generationLimiter on the paid routes inside their routers:
//   router.post("/creatives/:id/generate", generationLimiter, ...)
//   router.post("/creatives/:id/generate-video", generationLimiter, ...)
//   router.post("/creatives/:id/variants/:variantId/audio", generationLimiter, ...)
//   router.post("/creatives/:id/variants/:variantId/regenerate", generationLimiter, ...)
//   router.post("/rewrite", generationLimiter, ...)
//   router.post("/brands/:brandId/schedule-profile/generate", generationLimiter, ...)
```

For budget: add a `userId text` column to `cost_logs`, stamp it on every cost write, and enforce both a global daily cap (with a safe non-zero default) and a per-user daily sub-cap. Reuse the advisory-lock reservation pattern already in `generate.ts:180-223` — extract it into a shared `reserveBudget(userId, estimatedCost)` helper and call it from video/audio/rewrite/regenerate/schedule-profile too.

---

### 🟠 7 — Ungated delete/refresh of social accounts (DoS on the org's social presence)

**`routes/social-accounts.ts:76` and `:96`** — `DELETE /social-accounts/:id` and `POST /social-accounts/:id/refresh` are pure-authn. Any user can disconnect any brand's publishing accounts (calendar entries referencing them get `socialAccountId` nulled, silently breaking scheduled publishing), or repeatedly trigger refreshes; on a non-OK upstream response the refresh handler writes `status: "expired"`, so it can be abused to churn/expire tokens.

**Fix** — gate both behind `requireRole("admin")` (or at least `editor`), and don't downgrade status on *transient* upstream failures (only on a definitive `invalid_grant`/4xx):

```ts
router.delete("/social-accounts/:id", requireRole("admin"), validateRequest({ params: IdParams }), handler);
router.post("/social-accounts/:id/refresh", requireRole("editor"), validateRequest({ params: IdParams }), handler);
// in the refresh handler: only set status:"expired" when upstream returns invalid_grant (HTTP 400 with that error),
// not on 5xx/network errors — those are transient and should leave status untouched.
```

---

### 🟠 8 — `DELETE /templates/:id` is ungated

**`routes/templates.ts:95`** — pure-authn delete of a template (a brand asset that drives generation). Same class as #4/#7.

**Fix:** `router.delete("/templates/:id", requireRole("admin"), validateRequest({ params: IdParams }), handler);` Consider soft-delete given templates have versions.

---

### 🟠 9 — Mass-assignment on `PUT /content-plan/:id` (no validation schema)

**`routes/content-plan.ts:221-239`** — no `validateRequest`. The handler strips only `id` and `createdAt`, then spreads the rest:

```ts
// content-plan.ts (CURRENT)
const { id: _id, createdAt: _ca, ...updateFields } = body;
await db.update(...).set({ ...updateFields, updatedAt });   // every other key written verbatim
```

A client can repoint `linkedCreativeId` (FK → creatives) to an arbitrary creative, or write junk into any column.

**Fix** — validate with an explicit strict schema (or `.pick()` the editable fields) before the spread:

```ts
const UpdateContentPlanItemBody = z.object({
  title: z.string().optional(),
  status: z.enum(["idea","scheduled","published","archived"]).optional(),
  scheduledFor: z.string().datetime().nullish(),
  notes: z.string().nullish(),
  linkedCreativeId: z.string().nullish(),
}).strict();
router.put("/content-plan/:id", validateRequest({ params: IdParams, body: UpdateContentPlanItemBody }), handler);
```

---

### 🟠 10 — Arbitrary global-settings write can disable the budget cap

**`routes/settings.ts:7,20`** — `UpdateSettingsBody = z.record(z.string(), z.string())` accepts **any** key/value, and `PUT /settings` upserts each into `app_settings`. A user can set `dailyCostThreshold` to a huge value (neutering the budget gate in #6) or inject arbitrary keys consumed elsewhere. `GET /settings` returns the entire table.

**Fix** — enumerate permitted keys with a strict schema; redact/limit what `GET` returns:

```ts
const UpdateSettingsBody = z.object({
  dailyCostThreshold: z.coerce.number().nonnegative().optional(),
  // ...explicitly list each real setting...
}).strict();
// GET /settings: project to known keys only; never blanket-return the table if secrets might ever live here.
```

Gate `PUT /settings` behind `requireRole("admin")`.

---

### 🟠 11 — ffmpeg filtergraph injection via unvalidated `audioVolume` / `videoVolume`

**`routes/video.ts:178-284` (no `validateRequest`) → `services/audio-merge.ts:50-57`** — the volume values from `req.body` are string-interpolated into ffmpeg's `-filter_complex` argument (`` `[0:a]volume=${vidVol}[a1]...` ``). This is **not** shell injection (`execFile` with an argv array is used — good), but it **is** filtergraph injection: a value like `1[a];anullsrc;[a2]volume=1` injects extra filter nodes, enabling crashes / CPU-memory exhaustion / abuse of ffmpeg filter features.

**Fix** — coerce to bounded numbers at the route, and defensively in the service:

```ts
// video.ts (FIXED) — or add validateRequest({ body: AudioGenerateInput })
const num = (v: unknown, d: number) =>
  typeof v === "number" && isFinite(v) && v >= 0 && v <= 10 ? v : d;
audioVolume: num(audioVolume, 1.0),
videoVolume: num(videoVolume, 0.3),

// audio-merge.ts (defense in depth) — before interpolation:
const vidVol = Number(options.videoVolume);
if (!Number.isFinite(vidVol) || vidVol < 0 || vidVol > 10) throw new Error("invalid videoVolume");
```

---

## 🟡 Medium Issues

| # | Title | File:Line | Fix summary |
|---|-------|-----------|-------------|
| 12 | No timeout/AbortController on outbound provider fetches; sequential publish queue can stall | `publish-*.ts`, `services/claude.ts:108`, `services/imagen.ts:102`, `routes/video.ts:216` | Wrap fetches in `AbortSignal.timeout(...)`; pass a signal from `/audio` |
| 13 | SVG logo upload is stored-XSS-capable (safe only by accident) | `routes/brands.ts:114`, `routes/upload.ts:90` | Drop `image/svg+xml`; add `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment` for non-image types |
| 14 | Upload type check trusts client MIME; SVG→`sharp` rasterization DoS | `routes/brands.ts:114` → `services/compositing.ts:203` | Validate by magic bytes; `sharp(buf,{ limitInputPixels, failOn:'error' })` |
| 15 | No security headers (helmet) | `app.ts` | `app.use(helmet())` |
| 16 | Unauthenticated generated-file serving relies on UUID obscurity | `app.ts:100` | Acceptable short-term (path-traversal-checked); add auth or signed URLs if files are sensitive |
| 17 | Backslash open-redirect bypass in `sanitizeReturnTo` | `routes/auth.ts:7` | Reject `returnTo` containing `\` (browsers normalize `\`→`/` → protocol-relative redirect) |
| 18 | `platformMetadata` jsonb returned verbatim in `GET /social-accounts` | `routes/social-accounts.ts:27` | Audit what's stored there; field-filter the response |
| 19 | Unconstrained `status` columns (no DB CHECK, no Zod enum) | `schema/*.ts`, `api-zod` update schemas | Convert to `zod.enum`; add Postgres CHECK/enum types |
| 20 | `cost_logs` has no index on `created_at` | `schema/creatives.ts:125` | `index("cost_logs_created_idx").on(table.createdAt)` (+ `(service, createdAt)`) |
| 21 | `PUT /brands/:id/asset-config` stores unvalidated JSON blob | `routes/brands.ts:292` | Define & validate a Zod schema; cap size/depth |
| 22 | In-memory OAuth/PKCE store (not user-bound; leaks; breaks on multi-instance) | `routes/social-auth.ts:60` | Move to the session or a TTL store (Redis/PG); add a cleanup sweep; bind state to `req.user.id` |

**#17 detail (verified):** `sanitizeReturnTo` (`auth.ts:7-13`) allows `returnTo` values starting with a single `/` and rejects `//` and `://`, but **not** `\`. Input `/\evil.com` passes the check; `res.redirect("/\evil.com")` is normalized by browsers to `//evil.com` → a protocol-relative redirect to `evil.com`. Fix: `if (raw.includes("\\")) return "/";` in the guard.

---

## ⚪ Low Issues

| # | Title | File:Line | Fix summary |
|---|-------|-----------|-------------|
| 23 | Token-encryption key falls back to `SESSION_SECRET`; no key versioning/rotation | `services/token-encryption.ts:8` | Require a dedicated `TOKEN_ENCRYPTION_KEY`; prefix ciphertext with a key-version id |
| 24 | No global Express error handler → stack traces leak to client when `NODE_ENV!=production` | `app.ts` | Add terminal `(err,req,res,next)` middleware returning a sanitized 500 |
| 25 | Response-schema `.parse()` can 500 on valid DB rows | `routes/brands.ts:49,54,64` etc. | Pairs with #24; consider `safeParse` + logged 500 |
| 26 | `resolveLocalFilePath` prefix check lacks `path.sep` | `routes/generate.ts:46` | `resolved === root || resolved.startsWith(root + path.sep)` |
| 27 | SSRF blocklist in `validateUrl` is DNS-rebind/redirect/encoded-IP bypassable | `services/screenshot.ts:57` | Low because the fetch is delegated to ScreenshotOne; if you ever fetch the URL server-side, resolve DNS and re-check the IP |
| 28 | `console.error` instead of `logger` | `routes/creative-variants.ts:132`, `routes/calendar-entries.ts:157` | Use structured `logger` |
| 29 | `feedback.ts` trusts client-supplied `userEmail` | `routes/feedback.ts:14` | Use `req.user.email`; treat client value as untrusted log data only |
| 30 | Session cookie uses default name `connect.sid`; no rolling expiry | `lib/session.ts` | Set a custom `name`; consider `rolling: true` |
| 31 | Google account-linking doesn't check `email_verified` | `lib/passport.ts:79` | Covered by the `emailVerified` check in #1 |
| 32 | Most platforms blind-insert social accounts (no dedup) → duplicate rows | `routes/social-auth.ts` (twitter/instagram/linkedin/tiktok) | Upsert by `(platform, accountId)` like the YouTube branch already does |
| 33 | Query-param `limit` unbounded in schema (mitigated by handler clamps) | `api-zod` query schemas | Bound in schema: `.int().min(1).max(200).default(50)` |

---

## ✅ What Looks Good (don't undo these)

- **Token-at-rest encryption** is correct AES-256-GCM with a random per-record IV and auth tag (`services/token-encryption.ts`).
- **CSRF** is a sound Origin/Referer allow-list with OAuth-callback exemptions (`middleware/csrf.ts`).
- **Session config** is solid: `httpOnly`, `secure` in prod, `sameSite: "lax"`, PG-backed store, `SESSION_SECRET` required in prod (`lib/session.ts`).
- **Passport 0.7** regenerates the session on `req.logIn` → no session fixation.
- **CORS** allow-list is env-driven with no wildcards (`lib/allowed-origins.ts`).
- **Parameterized queries** throughout — every `sql\`\`` template interpolates only Drizzle column refs / bound params. No SQL injection found.
- **UUID primary keys** everywhere — no enumerable/sequential IDs.
- **Publish retry state machine** is well-built: transactional "publishing" claim, `MAX_RETRIES`, transient-vs-permanent error distinction, capped exponential backoff (`services/publish-scheduler.ts`).
- **Secrets are not leaked**: `GET /social-accounts` uses an explicit column allow-list that excludes `accessToken`/`refreshToken`; the logger redacts auth headers; decrypted tokens never leave the server.
- **`createdBy`/`uploadedBy` are server-stamped** after the body spread on create routes — not spoofable.
- **`download.ts` path traversal** is correctly guarded (`path.resolve` + `baseDir + path.sep`).
- **Upload size limits** exist (50 MB general, 10 MB images, 20 MB audio); list endpoints clamp `limit`/`offset` in code.

---

## 🚫 Investigated — DO NOT "fix" these (they are correct by design)

Changing these would add complexity or break working behavior:

1. **Dev auth bypass** (`middleware/auth.ts:36-43`) — `isDevBypass()` returns `false` whenever `NODE_ENV === "production"`. It is properly fenced. **Not a vulnerability.**
2. **No CSRF token** — intentional. CSRF is handled by the Origin/Referer allow-list (`middleware/csrf.ts`). Do not add token plumbing.
3. **Per-user data isolation ("user A sees user B's data")** — **by design.** The app is single-workspace, brand-scoped. `createdBy`/`reviewedBy` are audit fields, not access boundaries. Do not add per-user row filtering. (Authorization is meant to be *role*-based — see #2 — not per-user-ownership-based.)
4. **Outbound OAuth/publish `fetch` calls** go to **fixed provider hosts** (twitter.com, graph.facebook.com, linkedin.com, tiktok, googleapis). The user-supplied `code` is only ever a parameter to these fixed URLs. **Not SSRF.**
5. **`extractJSON` on LLM output** uses `JSON.parse`, not `eval`/`Function`. Safe.
6. **Compositing headline text** is HTML-escaped before being placed in the SVG (`services/compositing.ts:147-149`). The unescaped SVG attributes come from brand records, not user captions. Safe.
7. **Sequential per-iteration inserts** in `calendar-entries` batch / `creatives` schedule loops are bounded by the caller's own variant counts — not an unbounded N+1. (Optional: batch into one multi-row insert; not required.)
8. **`createInsertSchema` exports in `lib/db/src/schema/*`** are not used for request validation (routes validate via `@workspace/api-zod`). Leave them.

---

## Suggested Remediation Order

**Phase 1 — Close the access model (do these together; they're interdependent):**
1. #1 Email allow-list + default new users to `viewer` (`lib/passport.ts`).
2. #2 `requireRole` middleware + enforce `editor` on writes, `admin` on destructive ops (`middleware/auth.ts`, `app.ts`).
3. #4 Gate/soften `DELETE /brands/:id`; #7 social-account delete/refresh; #8 template delete (all use #2's middleware).

**Phase 2 — Close the data-integrity & publishing holes:**
4. #3 Brand-consistency checks on the publish path.
5. #5 Remove workflow fields from `UpdateCreativeBody`; add role-gated review endpoint.
6. #9 Validate `PUT /content-plan/:id`; #10 strict `settings` schema (admin-gated).

**Phase 3 — Cost control & injection:**
7. #6 Per-user generation limiter (after auth) + budget reservation on all paid routes + `userId` on `cost_logs`.
8. #11 Bound the ffmpeg volume params.

**Phase 4 — Hardening (Medium/Low):**
9. #12 fetch timeouts; #15 helmet; #17 backslash redirect; #13/#14 SVG/upload hardening; #20 cost_logs index; then the remaining Low items as time allows.

---

*Generated by an automated security & correctness review at commit `7123867`. Every Critical and High finding was verified by reading the execution path end-to-end; line numbers are accurate as of that commit. If a snippet doesn't match, search for the quoted code.*

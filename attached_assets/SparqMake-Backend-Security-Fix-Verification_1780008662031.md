# SparqMake — Security Fix Verification & Follow-up Remediation

**Repository:** https://github.com/tonydye6/SparqMake
**Verified at commit:** `5b8cf12` ("Improve API security, rate limiting, and user role management")
**Predecessor:** This is a follow-up to *SparqMake — Backend Code Review & Remediation Guide* (reviewed at `7123867`). It re-checks the fixes you pushed and lists what still needs work.
**Audience:** The Replit AI Agent implementing SparqMake. Two concrete fixes below — apply **R1 first** (it's a live functional break), then **R2**.

---

## How to read this document

- **Severity:** 🔴 Critical → 🟠 High → 🟡 Medium → ⚪ Low.
- Every item cites `file:line` at commit `5b8cf12`. Line numbers may drift as you edit — search for the quoted code if they don't match.
- Fixes are minimal and targeted. **Do not revert the original #16 fix wholesale** — see **§ Do NOT undo**.

---

## Verification summary — the original review is essentially done

I re-read the execution paths end-to-end on `main` (`5b8cf12`). **All four Criticals and every High are genuinely closed**, and several fixes exceed the recommendation (fail-closed allow-list, server-stamped reviewer, brand check that marks the entry permanently failed, `.strict()` settings/content-plan schemas, clamped ffmpeg volumes, hardened open-redirect guard, AES-256-GCM with a dedicated key). Nice work.

| # | Finding | Status | Evidence at `5b8cf12` |
|---|---------|--------|------------------------|
| 1 | OAuth allow-list / least-privilege | ✅ Closed | `lib/passport.ts:69-97` — fail-closed when allow-list unset; `emailVerified` check; new users default `viewer`; `ADMIN_EMAILS` bootstrap |
| 2 | RBAC enforced on writes | ✅ Closed | `middleware/auth.ts:106-124`; `app.ts:100` |
| 3 | Cross-brand publishing | ✅ Closed | `services/publish-scheduler.ts:163-187` — fails entry on brand mismatch (permanent) |
| 4 | `DELETE /brands/:id` guard | ✅ Closed | `routes/brands.ts:84` — `requireRole("admin")` |
| 5 | Creative self-approval | ✅ Closed | `routes/creatives.ts:122-174` — PUT strips review fields + blocks `approved/rejected`; `/review` is `requireRole("editor")` + server-stamps `req.user.id` |
| 7,8 | social-account / template delete gates | ✅ Closed | `requireRole("admin")` on the destructive routes |
| 9 | content-plan PUT validation | ✅ Closed | `routes/content-plan.ts:10-29` `.strict()` bounded schema; applied at `:245` |
| 10 | settings mass-assignment | ✅ Closed | `routes/settings.ts:18-20` `.strict()` allow-list, admin-gated, redundant key check |
| 11 | ffmpeg volume injection | ✅ Closed | `services/audio-merge.ts:50-55` — clamp to `[0,10]`, rejects NaN/∞; `execFile` args array |
| 15,24 | helmet + global error handler | ✅ Closed | `app.ts:20-24`, `app.ts:106-117` |
| 17 | Open redirect | ✅ Closed | `routes/auth.ts:7-16` — blocks `//`, `/\`, backslash, `://` |
| 23 | Token encryption | ✅ Sound | `services/token-encryption.ts` — AES-256-GCM, random IV, auth tag, fail-closed, dedicated `TOKEN_ENCRYPTION_KEY` |
| **16** | File-serving behind auth | 🔴 **Regression** | Closed the exposure but broke URL-pull publishing — **see R1** |
| **6** | Generation rate-limit | 🟠 **Residual gap** | Limiter is good but **`regenerate` is unmetered** — **see R2** |

**Two items remain. Both are below.**

---

## 🔴 R1 — Regression: generated media is no longer publicly fetchable, breaking Instagram & TikTok publishing

**Root cause.** The #16 fix moved the file-serving routes into the authenticated router:
`routes/upload.ts:121` → `routes/index.ts:34` (`router.use(uploadRouter)`) → `app.ts:100` (`app.use("/api", requireAuth, requireEditorForWrites, router)`).

So `GET /api/files/generated/:filename` now requires a session cookie. That is correct for a browser, but **two publishing paths hand a public URL to the platform's own servers, which fetch it anonymously** — and now get `401`:

- **Instagram** feed + story — passes `image_url` to the Graph API (`services/publish-instagram.ts:96,125`). The URL is built from `compositedImageUrl` → `/api/files/generated/...` (`services/publish-scheduler.ts:198,237`).
- **TikTok photo** posts — `source: "PULL_FROM_URL"` with `https://<domain>/api/files/generated/<file>` (`services/publish-tiktok.ts:127,246,259`).

**Confirmed unaffected** (they `readFileSync` and upload bytes directly, no URL fetch): Twitter (`publish-twitter.ts:73`), LinkedIn (`publish-linkedin.ts:71`), YouTube (`publish-youtube.ts:126`), and TikTok **video** (`FILE_UPLOAD`, `publish-tiktok.ts:62,203`).

**Net effect today:** scheduling an Instagram or TikTok-photo post will move to `publishing`, the platform will fail to fetch the image (`401`), and the entry lands in `failed`. Posting silently broke for those two platforms.

### Fix — serve *generated* media via a public route, mounted before `requireAuth`

Generated/composited media is content you are about to post publicly anyway, and filenames are unguessable `crypto.randomUUID()` values; `serveFile()` already blocks path traversal and pins the directory. So the correct fix is **not** to re-expose everything — it's to make only the `generated` directory publicly readable, and leave raw uploads + brand-assets behind auth.

**1. `routes/upload.ts`** — split the generated route onto a new exported public router; leave the rest authed:

```ts
// CURRENT (upload.ts:116-133)
router.get("/files/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(UPLOAD_DIR, filename, res);
});

router.get("/files/generated/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const generatedDir = path.join(UPLOAD_DIR, "generated");
  serveFile(generatedDir, filename, res);
});

router.get("/files/brand-assets/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const brandAssetsDir = path.join(UPLOAD_DIR, "brand-assets");
  serveFile(brandAssetsDir, filename, res);
});

export default router;
```

```ts
// AFTER
// Public router — mounted BEFORE requireAuth in app.ts.
// Instagram (image_url) and TikTok (PULL_FROM_URL) fetch generated media
// server-side with no session cookie, so this route must be unauthenticated.
// Filenames are unguessable UUIDs, the content is published publicly anyway,
// and serveFile() still rejects path traversal + pins the directory.
export const publicFilesRouter: IRouter = Router();

publicFilesRouter.get("/files/generated/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "generated"), filename, res);
});

// Raw uploads + brand assets stay behind requireAuth (the browser sends the cookie).
router.get("/files/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(UPLOAD_DIR, filename, res);
});

router.get("/files/brand-assets/:filename", (req, res): void => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  serveFile(path.join(UPLOAD_DIR, "brand-assets"), filename, res);
});

export default router;
```

> Note: the single-segment route `GET /files/:filename` does **not** match `/files/generated/x.png` (that's two segments), so there is no shadowing — the only `generated` handler is now the public one.

**2. `app.ts`** — import and mount the public router before the authed mount (it still passes through `fileServingLimiter`):

```ts
// near the other route imports (app.ts:13)
import router from "./routes";
import { publicFilesRouter } from "./routes/upload";   // ADD

// ... in the middleware chain, around app.ts:98-100:
app.use("/api/files", fileServingLimiter);              // existing (line 98)

// Public read of generated media — Instagram/TikTok pull it server-side.
// MUST be before requireAuth. Still rate-limited by fileServingLimiter above.
app.use("/api", publicFilesRouter);                     // ADD — before line 100

app.use("/api", requireAuth, requireEditorForWrites, router);   // existing (line 100)
```

That's the whole fix. No changes needed in the publish services — they already build the right URL; it just needs to resolve without a cookie again.

**Optional:** if you ever reference brand-asset URLs *directly* in a published post (you don't today — only composited `generated` output is pulled), move `/files/brand-assets/:filename` onto `publicFilesRouter` too. Leave raw `/files/:filename` (user uploads) authenticated.

---

## 🟠 R2 — Residual: the `regenerate` endpoint runs paid AI generation with no rate limit

**`routes/generate.ts:673`** — `POST /creatives/:id/variants/:variantId/regenerate` calls the same expensive path as `/generate` (`assembleContext` + `generateImage` at `:730`) but has **no `generationLimiter`**. The limiter is correctly applied to `/creatives/:id/generate` (`:137`) and the video/rewrite/schedule routes, so this one endpoint is the remaining unmetered cost vector — a single user can loop it and run up the image-generation bill.

`generationLimiter` is **already imported** (`generate.ts:17`), so this is a one-line change:

```ts
// CURRENT (generate.ts:673)
router.post("/creatives/:id/variants/:variantId/regenerate", async (req: Request, res: Response): Promise<void> => {

// AFTER
router.post("/creatives/:id/variants/:variantId/regenerate", generationLimiter, async (req: Request, res: Response): Promise<void> => {
```

**Also:** if `/creatives/:id/generate` performs a daily-budget check / reservation before generating (the original #6 recommended budget reservation on all paid routes), mirror that same check here so `regenerate` can't bypass the budget gate.

---

## Test / verification checklist

After applying both fixes, confirm:

- [ ] **Generated media is public again:** `curl -i https://<domain>/api/files/generated/<real-file>.png` with **no cookie** → `200` + image bytes (was `401`).
- [ ] **Raw uploads stay protected:** `curl -i https://<domain>/api/files/<an-upload>.png` with no cookie → still `401`.
- [ ] **Traversal still blocked:** `curl -i "https://<domain>/api/files/generated/..%2f..%2fpackage.json"` → `400`.
- [ ] **End-to-end:** schedule an **Instagram** post and a **TikTok photo** post → both reach `published` (not `failed` with a fetch error).
- [ ] **Regression-free byte uploaders:** a Twitter/LinkedIn/YouTube post still publishes.
- [ ] **Regenerate is limited:** fire 6+ `regenerate` calls within 60s → the 6th returns `429` with `{ "error": "Too many generation requests..." }`.

---

## Suggested order

1. **R1** first — it's a live functional break on two publishing channels. Low-risk, additive change (one new public route + one mount line).
2. **R2** second — one-line limiter add (+ optional budget mirror).

---

## Do NOT undo

- **Don't revert #16.** Keep `requireAuth` on the main router (`app.ts:100`). The fix is to carve out *only* `/api/files/generated/*` as public, not to re-open all file serving. Raw uploads (`/files/:filename`) and brand-assets stay authed.
- **Don't loosen `serveFile`'s traversal guard** (`upload.ts:77`) — the public route depends on it.
- Everything in the previous review's **§ What Looks Good** and **§ Investigated — DO NOT "fix"** still stands.

---

*Generated by an automated follow-up verification at commit `5b8cf12`. Every Critical/High from the prior review was re-checked by reading the execution path end-to-end; the two items above are the only remaining gaps, and both were confirmed by tracing the actual publish and generation code. If a snippet doesn't match, search for the quoted code.*

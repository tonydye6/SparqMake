# File storage on Object Storage — runbook

All durable files in SparqMake (raw uploads, brand logos/fonts, generated images
and video/audio, screenshots, curated asset-library media) flow through a single
service: `src/services/storage.ts`. Bytes live in **Replit Object Storage** when a
bucket is provisioned, with transparent fallback to the local `uploads/` disk tree.

The public `/api/files/...` URLs are unchanged by the backend — the DB keeps storing
the exact same URL strings; only the bytes move. No schema or row changes were
required.

## How it works

- **Namespaces → prefixes.** `uploads/`, `brand-assets/`, `generated/`, `assets/`.
  The bucket key and the disk subdir are derived from the namespace; see
  `NAMESPACES` in `storage.ts`.
- **Writes** go to the bucket when it is the active backend, otherwise to disk.
- **Reads are dual.** The active backend is tried first, then the other one. A file
  written to disk before migration is still served after the bucket becomes primary,
  and vice-versa.
- **Serving** (`serveStored`) supports HTTP Range (`206`), conditional requests
  (`304` via ETag), correct content types, and `Accept-Ranges`.
  - **True ranged reads from the bucket.** A `Range` request fetches the object's
    size from metadata and then opens a byte-ranged read stream
    (`downloadAsStream({ start, end })`, which the SDK forwards to GCS
    `createReadStream`), so video scrubbing transfers **only the requested bytes**
    and never buffers the whole object in memory. Full (`200`) reads stream too.
  - If a future SDK build does not expose ranged metadata/streaming, serving
    automatically falls back to a full (60s-cached) download + in-memory slice, so
    behavior degrades safely rather than breaking.
- **Deletes** are soft by default: the object is copied to a `trash/` prefix (bucket)
  / `uploads/trash/` tree (disk) and the live copy is removed **only after that copy
  succeeds** — if the trash copy fails, the live object is left intact (never an
  irreversible delete). Trashed objects are recoverable until the cleanup sweep
  purges them.
- **Ownership.** Protected namespaces (`uploads`, `brand-assets`, `assets`) sit
  behind `requireAuth` and are served only when the file is referenced by a DB row
  (`src/services/file-ownership.ts`); unknown/orphaned keys return `404`. The
  `generated` namespace is intentionally public (IG/TikTok pull media server-side
  with no cookie); its only protection is the unguessable UUID filename.

### A note on tenant isolation

The spec asks that "a user can only retrieve files their own brand/organization
owns." This app has **no user→brand/organization relationship** in the schema —
`users` carry a `role` only (viewer/editor/admin), and brand context is a
client-supplied `brandId` query param with no server-side per-user ownership. Every
authenticated editor can already access every brand by design. True cross-tenant
isolation would require introducing a user↔brand linkage, which is explicitly out of
scope ("Any database schema or column changes" are excluded).

What is enforced instead — and what actually closes the original
"logged-in-user-can-fetch-any-UUID" gap — is the **reference check**: an
authenticated user cannot fetch an arbitrary bucket key; the object must be
referenced by a durable DB record or the request is rejected (`404`). If a
multi-tenant model is later added, `isFileReferenced` is the single place to extend
into a per-tenant ownership check.

## Configuration flags

| Variable | Effect |
| --- | --- |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | When set, the bucket backend is available. Unset → disk only. |
| `STORAGE_BACKEND` | `auto`/`bucket`/unset → write to bucket (default). `disk` → force new writes to disk (reversible kill-switch); reads still fall back to the bucket. |

## Migration steps

1. **Provision** an Object Storage bucket so `DEFAULT_OBJECT_STORAGE_BUCKET_ID` is set.
2. **Deploy** the code. New writes immediately go to the bucket; old files keep
   serving from disk via the dual-read fallback.
3. **Backfill** existing disk files into the bucket:
   ```
   pnpm --filter @workspace/api-server exec tsx scripts/backfill-disk-to-bucket.ts --dry-run
   pnpm --filter @workspace/api-server exec tsx scripts/backfill-disk-to-bucket.ts
   ```
4. **Reconcile** DB references against the bucket. By default this is a read-only
   report of broken media (MISSING) and unreferenced objects (ORPHAN). It scans
   every file-bearing column: `assets.fileUrl`/`thumbnailUrl`,
   `brands.logoFileUrl`/`brandFonts`, the five `creative_variants` media columns,
   and `creatives.referenceScreenshots`.
   ```
   pnpm --filter @workspace/api-server exec tsx scripts/reconcile-orphans.ts
   ```
   To stop the UI rendering broken media, opt in to clearing dangling URLs. This
   nulls the URL on the owning row for scalar (text) columns; JSON columns
   (`brandFonts`, `referenceScreenshots`) are report-only. The DB rows themselves
   are never deleted.
   ```
   pnpm --filter @workspace/api-server exec tsx scripts/reconcile-orphans.ts --clear-missing
   ```
5. Once reconcile shows no `MISSING` entries, the disk copies are redundant. They
   are also ephemeral on Replit, so no explicit teardown is required.

### Rollback

Set `STORAGE_BACKEND=disk` and redeploy. New writes return to disk; bucket-resident
files keep serving via fallback. No data migration needed to roll back.

## Cleanup (soft-delete sweep)

```
# disk trash older than 30 days; lists bucket trash without deleting
pnpm --filter @workspace/api-server exec tsx scripts/cleanup-soft-deleted.ts

# also hard-delete bucket trash
pnpm --filter @workspace/api-server exec tsx scripts/cleanup-soft-deleted.ts --purge --older-than-days 14
```

The `@replit/object-storage` SDK exposes no per-object timestamp, so the bucket side
is purged wholesale (only with `--purge`); the disk side honors `--older-than-days`
via file mtime.

### Record deletes also soft-delete backing objects

Deleting a DB row that owns files must move those objects to `trash/` too, or the
bucket accumulates unreferenced data (disk used to self-clear on restart; the bucket
does not). All destructive asset endpoints (`DELETE /assets/:id`,
`POST /assets/bulk-delete`) resolve each returned row's `fileUrl`/`thumbnailUrl` and
soft-delete the objects after the DB delete. Use the returned rows (`.returning()`)
so the URLs are known after deletion.

## Orphan sweep (live → trash)

Some objects become unreferenced without ever passing through a record delete:
raw uploads that were never attached (the upload→create-record gap) and media left
behind by abandoned/failed generations. The orphan sweep finds live objects that no
DB row references and moves the aged ones to `trash/` (recoverable via the cleanup
sweep above).

```
# dry-run: list aged (>7d) unreferenced disk objects that would be trashed
pnpm --filter @workspace/api-server exec tsx scripts/sweep-orphans.ts

# act on them
pnpm --filter @workspace/api-server exec tsx scripts/sweep-orphans.ts --apply

# tune the age guard
pnpm --filter @workspace/api-server exec tsx scripts/sweep-orphans.ts --apply --older-than-days 14

# also sweep undated bucket-only orphans (run when no uploads are in flight)
pnpm --filter @workspace/api-server exec tsx scripts/sweep-orphans.ts --apply --include-bucket
```

Safety model:

- **Dry-run by default**; `--apply` is required to move anything.
- **Soft-delete only** — objects go to `trash/` and are purged later by
  `cleanup-soft-deleted.ts`, so a mistaken sweep is recoverable.
- **Age guard** — disk objects are swept only when their mtime is older than
  `--older-than-days` (default 7), which protects files still in the
  upload→create-record gap.
- **Bucket limitation** — the SDK exposes no per-object timestamp, so bucket-only
  objects cannot be aged and are swept only with the explicit `--include-bucket`
  opt-in. Run that variant when no uploads are in flight; `trash/` recovery is the
  backstop if a just-uploaded object is caught.

Both the sweep and `reconcile-orphans.ts` share `src/services/file-references.ts`
(`gatherFileReferences`) for the whole-DB reference inventory, so their notion of
"referenced" stays in lockstep.

## Recommendation: serve generated media via direct public URLs

Today every read is proxied through the api-server (`GET /api/files/...`), which
downloads bucket bytes into the app before streaming them out. For the **public
`generated` namespace** this is pure overhead. Object Storage can serve those
objects directly, which removes the proxy hop, the in-process read cache, and the
app's bandwidth from the hot path — a meaningful win for video.

Suggested follow-up (not part of this migration): publish `generated/` objects under
a public-read prefix (or a CDN/signed-URL front), and have `publicUrlFor("generated")`
return that direct URL while protected namespaces keep flowing through the
ownership-checked proxy. Because URLs are centralized in `storage.ts`, this is a
localized change.

## Tests

`src/services/storage.test.ts` (vitest) covers URL resolution, content types, the
write/read round-trip, and serve behaviors (200 / 206 / 416 / 304 / 404 / 400)
against the disk backend.

```
pnpm --filter @workspace/api-server run test
```

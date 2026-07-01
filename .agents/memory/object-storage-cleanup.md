---
name: Object Storage cleanup & aging
description: Durable constraints for any age-based or recoverable cleanup of Replit Object Storage
---

# Object Storage cleanup & aging

- The `@replit/object-storage` SDK gives objects a `name` only — **no per-object
  timestamp**. You cannot age bucket objects from the SDK, so age-based lifecycle
  logic only works on disk-resident copies (via mtime). If real bucket aging is
  ever needed, persist an upload timestamp yourself (DB row or object key); don't
  expect the SDK to provide it.
  **Why:** without a timestamp you can't distinguish a fresh unattached upload from
  an abandoned one, so any bucket sweep must be opt-in + recoverable, not age-gated.

- **Soft-delete must be recoverable: stage the trash copy first, and only delete
  the live object if that copy succeeded.** Deleting first (or deleting on copy
  failure) is an irreversible-data-loss bug and will be rejected in review.
  **How to apply:** in any delete path, on trash-copy failure leave the live object
  in place and surface the error; objects in `trash/` are purged later by a separate
  recovery-window sweep, never inline.

- **Record-delete contract is DB-first-transactional, then soft-delete storage,
  then orphan-sweep reconciles.** `deleteObject` returns `{ ok, error }` (not
  `void`); `softDeleteBackingObjects` in `src/services/deletion.ts` aggregates
  per-URL results so callers report partial failure (never swallow). Deleting the
  DB row before touching storage means the only failure drift is an orphan file
  (safe, swept later) — never a dangling DB reference (user-visible broken media).
  **Why:** the two drift directions are not symmetric; keep the safe one.

- **Regeneration is NOT a storage orphan source — don't "fix" it.** `generate.ts`
  regen deletes+reinserts `creative_variants` but the new variant filenames are
  deterministic (`${creativeId}_${platform}_raw|composited.png`), so new writes
  overwrite the same object keys. Soft-deleting the "old" URLs there would delete
  the just-written live files. Only a changed platform set leaves a stray, which
  the orphan sweep handles. **Why:** looks like an orphan bug but isn't.

- **True ranged reads are possible despite the typed API hiding them.**
  `Client.downloadAsStream(key, opts)` forwards `opts` straight to the underlying
  `@google-cloud/storage` `file.createReadStream(opts)`, so passing `{ start, end }`
  (cast past the SDK's `DownloadOptions`, which only declares `decompress`) yields a
  real byte-ranged GCS read — no full download. Object size/ETag come from
  `(client as any).getBucket()` → `file(key).getMetadata()` (size, md5Hash). Both
  reach past the public types, so probe defensively and keep a full-download
  fallback. **Why:** serving Range with a full download buffers whole videos in
  memory and re-transfers them per seek — reviewers reject it as a perf regression.

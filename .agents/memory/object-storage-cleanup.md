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

- **True ranged reads are possible despite the typed API hiding them.**
  `Client.downloadAsStream(key, opts)` forwards `opts` straight to the underlying
  `@google-cloud/storage` `file.createReadStream(opts)`, so passing `{ start, end }`
  (cast past the SDK's `DownloadOptions`, which only declares `decompress`) yields a
  real byte-ranged GCS read — no full download. Object size/ETag come from
  `(client as any).getBucket()` → `file(key).getMetadata()` (size, md5Hash). Both
  reach past the public types, so probe defensively and keep a full-download
  fallback. **Why:** serving Range with a full download buffers whole videos in
  memory and re-transfers them per seek — reviewers reject it as a perf regression.

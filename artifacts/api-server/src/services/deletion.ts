import { deleteObject, resolveUrl } from "./storage.js";

/**
 * Shared, drift-safe deletion helpers.
 * ------------------------------------
 * The delete contract across the API server is **transaction + reconciliation**:
 *
 *   1. Delete the owning DB row(s) first (inside a `db.transaction()` when more
 *      than one statement is involved). The user-visible invariant "no DB row
 *      points at a missing file" is preserved because the row is gone before we
 *      touch storage.
 *   2. Soft-delete every storage object the deleted row(s) referenced. Soft
 *      delete is recoverable (objects move to `trash/`), and each object's
 *      success/failure is reported — never silently swallowed.
 *   3. Any residual drift (a storage object that could not be removed in step 2,
 *      or a cascade child whose row was removed by a DB `ON DELETE CASCADE` —
 *      e.g. a creative's `creative_variants` and their generated media) is an
 *      *orphaned object*, which is reconciled by the orphan sweep
 *      (`scripts/sweep-orphans.ts`). It uses `gatherFileReferences`
 *      (`src/services/file-references.ts`), which inventories every file-bearing
 *      column including all `creative_variants` media, so cascade-orphaned media
 *      is detected and moved to `trash/`. This is the documented backstop that
 *      keeps the bucket from accumulating orphans without requiring a
 *      cross-system 2-phase commit.
 *
 * Because the failure mode is always the *safe* direction (an orphaned object,
 * never a dangling DB reference), a delete that partially fails at the storage
 * step is still consistent from the application's point of view, and the sweep
 * cleans up the bytes later.
 */

/**
 * Maximum number of ids accepted by a single bulk-delete call. A single request
 * should never fan out into an unbounded number of DB deletes + storage removals
 * (which risks request timeouts and huge audit rows); clients must page beyond
 * this.
 */
export const MAX_BULK_DELETE = 100;

export interface StorageCleanupResult {
  /** URLs whose backing object was removed (or was already absent). */
  removed: string[];
  /** URLs whose backing object could not be removed (surface, don't swallow). */
  failed: string[];
}

/**
 * Soft-delete every storage object backing the given URLs. External or
 * unresolvable URLs are skipped, and duplicate locations are collapsed so the
 * same object is not deleted twice. Returns which URLs were removed and which
 * failed so the caller can report partial failure instead of swallowing storage
 * errors. This never throws — storage-level failures are reported via the result.
 */
export async function softDeleteBackingObjects(
  urls: Array<string | null | undefined>,
): Promise<StorageCleanupResult> {
  const removed: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (!url) continue;
    const loc = resolveUrl(url);
    if (!loc) continue; // external / not bucket-managed — nothing to delete
    const dedupKey = `${loc.namespace}/${loc.filename}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const res = await deleteObject(loc);
    if (res.ok) removed.push(url);
    else failed.push(url);
  }

  return { removed, failed };
}

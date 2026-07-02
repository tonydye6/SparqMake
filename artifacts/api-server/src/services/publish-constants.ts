/**
 * Shared constants for the publish scheduler and the failure-alert sweep.
 * Kept in their own module so the alert service and the scheduler can agree on
 * what "permanently failed" means without importing each other.
 */
export const MAX_RETRIES = 3;

/**
 * An entry is permanently failed when the scheduler will never pick it up
 * again on its own: retries are exhausted, or it has no social account (the
 * retry poll only considers entries with a connected account).
 */
export function isPermanentlyFailed(entry: { publishStatus: string; retryCount: number | null; socialAccountId: string | null }): boolean {
  if (entry.publishStatus !== "failed") return false;
  return (entry.retryCount ?? 0) >= MAX_RETRIES || !entry.socialAccountId;
}

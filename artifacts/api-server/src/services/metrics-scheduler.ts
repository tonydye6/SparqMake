import { eq, and, gte, isNotNull, sql, inArray } from "drizzle-orm";
import { db, calendarEntriesTable, socialAccountsTable, postMetricsTable } from "@workspace/db";
import { fetchMetricsForPlatform } from "./post-metrics-fetchers";
import { decryptToken } from "./token-encryption";
import { logger } from "../lib/logger";

// How often the poller wakes up.
const POLL_INTERVAL_MS = 15 * 60_000;
// A post's metrics are refreshed when its newest snapshot is older than this.
const REFRESH_AFTER_MS = 6 * 60 * 60_000;
// Metrics are tracked for posts published within this window.
const TRACKING_WINDOW_MS = 30 * 24 * 60 * 60_000;
// Per-platform cap per polling cycle, plus a spacing delay between calls, to
// stay well under every platform's rate limits.
const MAX_FETCHES_PER_PLATFORM_PER_CYCLE = 10;
const DELAY_BETWEEN_CALLS_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// instagram_feed/instagram_story entries use the shared "instagram" rate
// budget; everything else buckets by its own platform value.
function rateBucket(platform: string): string {
  if (platform.startsWith("instagram")) return "instagram";
  return platform;
}

export async function pollAndFetchMetrics(): Promise<void> {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - TRACKING_WINDOW_MS);

    const publishedEntries = await db.select()
      .from(calendarEntriesTable)
      .where(and(
        eq(calendarEntriesTable.publishStatus, "published"),
        isNotNull(calendarEntriesTable.platformPostId),
        isNotNull(calendarEntriesTable.socialAccountId),
        gte(calendarEntriesTable.publishedAt, windowStart),
      ));

    if (publishedEntries.length === 0) return;

    const entryIds = publishedEntries.map(e => e.id);
    const lastFetches = await db.select({
      calendarEntryId: postMetricsTable.calendarEntryId,
      lastFetchedAt: sql<string>`MAX(${postMetricsTable.fetchedAt})`,
    }).from(postMetricsTable)
      .where(inArray(postMetricsTable.calendarEntryId, entryIds))
      .groupBy(postMetricsTable.calendarEntryId);

    const lastFetchedMap = new Map<string, number>();
    for (const row of lastFetches) {
      lastFetchedMap.set(row.calendarEntryId, new Date(row.lastFetchedAt).getTime());
    }

    const dueEntries = publishedEntries.filter(entry => {
      const last = lastFetchedMap.get(entry.id);
      return last === undefined || (now.getTime() - last) >= REFRESH_AFTER_MS;
    });

    if (dueEntries.length === 0) return;

    logger.info({ due: dueEntries.length, tracked: publishedEntries.length }, "Fetching post metrics");

    // Cache decrypted tokens per social account within a cycle.
    const accountCache = new Map<string, { accessToken: string; status: string } | null>();
    // Per-platform accounting: cap per cycle and stop the platform entirely on
    // a 429 so we never hammer a rate-limited API.
    const fetchesPerBucket = new Map<string, number>();
    const haltedBuckets = new Set<string>();

    for (const entry of dueEntries) {
      const bucket = rateBucket(entry.platform);
      if (haltedBuckets.has(bucket)) continue;
      const done = fetchesPerBucket.get(bucket) || 0;
      if (done >= MAX_FETCHES_PER_PLATFORM_PER_CYCLE) continue;

      let account = accountCache.get(entry.socialAccountId!);
      if (account === undefined) {
        const [row] = await db.select().from(socialAccountsTable)
          .where(eq(socialAccountsTable.id, entry.socialAccountId!));
        if (!row || row.status === "revoked" || row.status === "expired") {
          account = null;
        } else {
          try {
            account = { accessToken: decryptToken(row.accessToken), status: row.status };
          } catch (err) {
            logger.warn({ err, socialAccountId: row.id }, "Failed to decrypt token for metrics fetch");
            account = null;
          }
        }
        accountCache.set(entry.socialAccountId!, account);
      }
      if (!account) continue;

      fetchesPerBucket.set(bucket, done + 1);
      const result = await fetchMetricsForPlatform(entry.platform, account.accessToken, entry.platformPostId!);

      if (result.success && result.metrics) {
        await db.insert(postMetricsTable).values({
          calendarEntryId: entry.id,
          platform: entry.platform,
          impressions: result.metrics.impressions ?? null,
          views: result.metrics.views ?? null,
          likes: result.metrics.likes ?? null,
          comments: result.metrics.comments ?? null,
          shares: result.metrics.shares ?? null,
          raw: result.raw ?? null,
        });
        logger.info({ entryId: entry.id, platform: entry.platform }, "Stored post metrics snapshot");
      } else {
        if (result.httpStatus === 429) {
          haltedBuckets.add(bucket);
          logger.warn({ platform: entry.platform }, "Metrics API rate limited — pausing platform until next cycle");
        } else {
          logger.warn({ entryId: entry.id, platform: entry.platform, error: result.error }, "Metrics fetch failed");
        }
      }

      await sleep(DELAY_BETWEEN_CALLS_MS);
    }
  } catch (err) {
    logger.error({ err }, "Metrics scheduler poll error");
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startMetricsScheduler(): void {
  if (intervalId) {
    logger.warn("Metrics scheduler already running");
    return;
  }
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Starting post metrics scheduler");
  intervalId = setInterval(pollAndFetchMetrics, POLL_INTERVAL_MS);
  pollAndFetchMetrics();
}

export function stopMetricsScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("Metrics scheduler stopped");
  }
}

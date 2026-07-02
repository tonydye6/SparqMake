import { Router, type IRouter } from "express";
import { eq, and, gte, lte, asc, inArray, sql } from "drizzle-orm";
import {
  db,
  calendarEntriesTable,
  creativesTable,
  creativeVariantsTable,
  postMetricsTable,
} from "@workspace/db";

const router: IRouter = Router();

function parseValidDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

interface LatestMetric {
  calendarEntryId: string;
  impressions: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  fetchedAt: Date;
}

// Latest snapshot per calendar entry (one row per entry, newest fetch wins).
async function getLatestMetrics(entryIds: string[]): Promise<Map<string, LatestMetric>> {
  const map = new Map<string, LatestMetric>();
  if (entryIds.length === 0) return map;

  const rows = await db
    .selectDistinctOn([postMetricsTable.calendarEntryId], {
      calendarEntryId: postMetricsTable.calendarEntryId,
      impressions: postMetricsTable.impressions,
      views: postMetricsTable.views,
      likes: postMetricsTable.likes,
      comments: postMetricsTable.comments,
      shares: postMetricsTable.shares,
      fetchedAt: postMetricsTable.fetchedAt,
    })
    .from(postMetricsTable)
    .where(inArray(postMetricsTable.calendarEntryId, entryIds))
    .orderBy(postMetricsTable.calendarEntryId, sql`${postMetricsTable.fetchedAt} DESC`);

  for (const row of rows) {
    map.set(row.calendarEntryId, row);
  }
  return map;
}

// Engagement = likes + comments + shares (nulls treated as 0 for ranking only).
function engagement(m: LatestMetric): number {
  return (m.likes || 0) + (m.comments || 0) + (m.shares || 0);
}

// GET /post-metrics/summary — aggregated performance with brand/platform/
// template/date filters, modeled on /cost-logs/summary.
router.get("/post-metrics/summary", async (req, res): Promise<void> => {
  const { startDate, endDate, brandId, platform, templateId } = req.query;

  if (startDate && !parseValidDate(startDate)) {
    res.status(400).json({ error: "Invalid startDate format" });
    return;
  }
  if (endDate && !parseValidDate(endDate)) {
    res.status(400).json({ error: "Invalid endDate format" });
    return;
  }

  const conditions = [eq(calendarEntriesTable.publishStatus, "published")];
  const parsedStart = parseValidDate(startDate);
  const parsedEnd = parseValidDate(endDate);
  if (parsedStart) conditions.push(gte(calendarEntriesTable.publishedAt, parsedStart));
  if (parsedEnd) conditions.push(lte(calendarEntriesTable.publishedAt, parsedEnd));
  if (platform) conditions.push(eq(calendarEntriesTable.platform, platform as string));
  if (brandId) conditions.push(eq(creativesTable.brandId, brandId as string));
  if (templateId) conditions.push(eq(creativesTable.templateId, templateId as string));

  const entries = await db
    .select({
      id: calendarEntriesTable.id,
      platform: calendarEntriesTable.platform,
      publishedAt: calendarEntriesTable.publishedAt,
      platformPostId: calendarEntriesTable.platformPostId,
      creativeId: calendarEntriesTable.creativeId,
      creativeName: creativesTable.name,
      brandId: creativesTable.brandId,
      templateId: creativesTable.templateId,
      caption: creativeVariantsTable.caption,
      imageUrl: creativeVariantsTable.compositedImageUrl,
    })
    .from(calendarEntriesTable)
    .innerJoin(creativesTable, eq(calendarEntriesTable.creativeId, creativesTable.id))
    .leftJoin(creativeVariantsTable, eq(calendarEntriesTable.variantId, creativeVariantsTable.id))
    .where(and(...conditions));

  const latest = await getLatestMetrics(entries.map(e => e.id));

  const totals = { impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, engagements: 0 };
  let postsWithMetrics = 0;

  const platformMap = new Map<string, {
    platform: string; posts: number; postsWithMetrics: number;
    impressions: number; views: number; likes: number; comments: number; shares: number; engagements: number;
  }>();
  const dailyMap = new Map<string, { date: string; posts: number; impressions: number; engagements: number }>();

  const posts: Array<{
    calendarEntryId: string;
    platform: string;
    publishedAt: Date | null;
    platformPostId: string | null;
    creativeId: string;
    creativeName: string;
    brandId: string;
    templateId: string | null;
    caption: string | null;
    imageUrl: string | null;
    metrics: Omit<LatestMetric, "calendarEntryId"> | null;
    engagements: number | null;
  }> = [];

  for (const entry of entries) {
    let p = platformMap.get(entry.platform);
    if (!p) {
      p = { platform: entry.platform, posts: 0, postsWithMetrics: 0, impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, engagements: 0 };
      platformMap.set(entry.platform, p);
    }
    p.posts += 1;

    const m = latest.get(entry.id) || null;
    if (m) {
      postsWithMetrics += 1;
      p.postsWithMetrics += 1;
      const eng = engagement(m);
      totals.impressions += m.impressions || 0;
      totals.views += m.views || 0;
      totals.likes += m.likes || 0;
      totals.comments += m.comments || 0;
      totals.shares += m.shares || 0;
      totals.engagements += eng;
      p.impressions += m.impressions || 0;
      p.views += m.views || 0;
      p.likes += m.likes || 0;
      p.comments += m.comments || 0;
      p.shares += m.shares || 0;
      p.engagements += eng;

      if (entry.publishedAt) {
        const dateKey = entry.publishedAt.toISOString().slice(0, 10);
        let d = dailyMap.get(dateKey);
        if (!d) {
          d = { date: dateKey, posts: 0, impressions: 0, engagements: 0 };
          dailyMap.set(dateKey, d);
        }
        d.posts += 1;
        d.impressions += m.impressions || 0;
        d.engagements += eng;
      }
    }

    posts.push({
      calendarEntryId: entry.id,
      platform: entry.platform,
      publishedAt: entry.publishedAt,
      platformPostId: entry.platformPostId,
      creativeId: entry.creativeId,
      creativeName: entry.creativeName,
      brandId: entry.brandId,
      templateId: entry.templateId,
      caption: entry.caption ?? null,
      imageUrl: entry.imageUrl ?? null,
      metrics: m ? {
        impressions: m.impressions,
        views: m.views,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        fetchedAt: m.fetchedAt,
      } : null,
      engagements: m ? engagement(m) : null,
    });
  }

  const topPosts = posts
    .filter(post => post.metrics !== null)
    .sort((a, b) => (b.engagements || 0) - (a.engagements || 0))
    .slice(0, 10);

  res.json({
    totalPosts: entries.length,
    postsWithMetrics,
    totals,
    byPlatform: Array.from(platformMap.values()),
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    topPosts,
    posts: posts.sort((a, b) => {
      const at = a.publishedAt ? a.publishedAt.getTime() : 0;
      const bt = b.publishedAt ? b.publishedAt.getTime() : 0;
      return bt - at;
    }),
  });
});

// GET /post-metrics/latest — latest snapshot per published entry, keyed by
// calendar entry ID. Used by the calendar to show metrics inline.
router.get("/post-metrics/latest", async (req, res): Promise<void> => {
  const { entryIds } = req.query;

  let ids: string[];
  if (typeof entryIds === "string" && entryIds.trim()) {
    ids = entryIds.split(",").map(s => s.trim()).filter(Boolean).slice(0, 500);
  } else {
    const published = await db.select({ id: calendarEntriesTable.id })
      .from(calendarEntriesTable)
      .where(eq(calendarEntriesTable.publishStatus, "published"));
    ids = published.map(e => e.id);
  }

  const latest = await getLatestMetrics(ids);
  const result: Record<string, Omit<LatestMetric, "calendarEntryId">> = {};
  for (const [entryId, m] of latest) {
    result[entryId] = {
      impressions: m.impressions,
      views: m.views,
      likes: m.likes,
      comments: m.comments,
      shares: m.shares,
      fetchedAt: m.fetchedAt,
    };
  }
  res.json(result);
});

// GET /post-metrics?calendarEntryId=... — full snapshot history for one entry
// (oldest first), for growth-over-time views and the refinement engine.
router.get("/post-metrics", async (req, res): Promise<void> => {
  const { calendarEntryId } = req.query;
  if (!calendarEntryId || typeof calendarEntryId !== "string") {
    res.status(400).json({ error: "calendarEntryId query parameter is required" });
    return;
  }

  const snapshots = await db.select({
    id: postMetricsTable.id,
    calendarEntryId: postMetricsTable.calendarEntryId,
    platform: postMetricsTable.platform,
    impressions: postMetricsTable.impressions,
    views: postMetricsTable.views,
    likes: postMetricsTable.likes,
    comments: postMetricsTable.comments,
    shares: postMetricsTable.shares,
    fetchedAt: postMetricsTable.fetchedAt,
  }).from(postMetricsTable)
    .where(eq(postMetricsTable.calendarEntryId, calendarEntryId))
    .orderBy(asc(postMetricsTable.fetchedAt));

  res.json(snapshots);
});

export default router;

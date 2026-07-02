import { logger } from "../lib/logger";

// Normalized per-post metric set. Every field is optional because platforms
// expose different subsets; `null`/undefined means the platform did not report
// that metric, which callers must preserve (do not coerce to 0).
export interface NormalizedMetrics {
  impressions?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
}

export interface MetricsFetchResult {
  success: boolean;
  metrics?: NormalizedMetrics;
  raw?: unknown;
  error?: string;
  httpStatus?: number;
}

function toCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// --- Twitter/X ---------------------------------------------------------------
// GET /2/tweets/:id?tweet.fields=public_metrics with the user's OAuth2 token.
// public_metrics: retweet_count, reply_count, like_count, quote_count,
// impression_count (impression_count only for the authenticated author).
export async function fetchTwitterMetrics(accessToken: string, tweetId: string): Promise<MetricsFetchResult> {
  try {
    const url = `https://api.twitter.com/2/tweets/${encodeURIComponent(tweetId)}?tweet.fields=public_metrics`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `Twitter metrics error (${resp.status}): ${body}`, httpStatus: resp.status };
    }
    const data = await resp.json() as {
      data?: {
        public_metrics?: {
          retweet_count?: number;
          reply_count?: number;
          like_count?: number;
          quote_count?: number;
          impression_count?: number;
        };
      };
      errors?: Array<{ detail?: string; title?: string }>;
    };
    const pm = data.data?.public_metrics;
    if (!pm) {
      const detail = data.errors?.[0]?.detail || data.errors?.[0]?.title || "No public_metrics in response";
      return { success: false, error: `Twitter metrics unavailable: ${detail}`, raw: data };
    }
    const retweets = toCount(pm.retweet_count) ?? 0;
    const quotes = toCount(pm.quote_count) ?? 0;
    return {
      success: true,
      metrics: {
        impressions: toCount(pm.impression_count),
        likes: toCount(pm.like_count),
        comments: toCount(pm.reply_count),
        shares: retweets + quotes,
      },
      raw: data,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown Twitter metrics error" };
  }
}

// --- Instagram ---------------------------------------------------------------
// Basic counts come from the media node fields; richer reach/impression data
// comes from the insights edge. Insights can fail independently (e.g. media
// too old, story expired, insufficient permissions) — we degrade to counts.
export async function fetchInstagramMetrics(accessToken: string, mediaId: string): Promise<MetricsFetchResult> {
  try {
    const base = "https://graph.facebook.com/v21.0";
    const fieldsUrl = `${base}/${encodeURIComponent(mediaId)}?fields=like_count,comments_count&access_token=${encodeURIComponent(accessToken)}`;
    const fieldsResp = await fetch(fieldsUrl);
    if (!fieldsResp.ok) {
      const body = await fieldsResp.text();
      return { success: false, error: `Instagram metrics error (${fieldsResp.status}): ${body}`, httpStatus: fieldsResp.status };
    }
    const fields = await fieldsResp.json() as { like_count?: number; comments_count?: number };

    let impressions: number | null = null;
    let views: number | null = null;
    let shares: number | null = null;
    let insightsRaw: unknown = null;
    try {
      const insightsUrl = `${base}/${encodeURIComponent(mediaId)}/insights?metric=impressions,reach,views,shares&access_token=${encodeURIComponent(accessToken)}`;
      const insightsResp = await fetch(insightsUrl);
      if (insightsResp.ok) {
        const insights = await insightsResp.json() as {
          data?: Array<{ name?: string; values?: Array<{ value?: number }> }>;
        };
        insightsRaw = insights;
        for (const metric of insights.data || []) {
          const value = toCount(metric.values?.[0]?.value);
          if (metric.name === "impressions") impressions = value;
          if (metric.name === "views" && value !== null) views = value;
          if (metric.name === "reach" && impressions === null) impressions = value;
          if (metric.name === "shares") shares = value;
        }
      } else {
        logger.info({ mediaId, status: insightsResp.status }, "Instagram insights unavailable — using basic counts only");
      }
    } catch {
      // Insights are best-effort; basic counts still succeed.
    }

    return {
      success: true,
      metrics: {
        impressions,
        views,
        likes: toCount(fields.like_count),
        comments: toCount(fields.comments_count),
        shares,
      },
      raw: { fields, insights: insightsRaw },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown Instagram metrics error" };
  }
}

// --- LinkedIn ----------------------------------------------------------------
// Member posts only expose social actions (likes/comments) via
// /v2/socialActions/{urn}. Impressions require an organization account, so
// they are reported as null here.
export async function fetchLinkedInMetrics(accessToken: string, postUrn: string): Promise<MetricsFetchResult> {
  try {
    const url = `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `LinkedIn metrics error (${resp.status}): ${body}`, httpStatus: resp.status };
    }
    const data = await resp.json() as {
      likesSummary?: { totalLikes?: number };
      commentsSummary?: { aggregatedTotalComments?: number; totalFirstLevelComments?: number };
    };
    return {
      success: true,
      metrics: {
        impressions: null,
        views: null,
        likes: toCount(data.likesSummary?.totalLikes),
        comments: toCount(data.commentsSummary?.aggregatedTotalComments ?? data.commentsSummary?.totalFirstLevelComments),
        shares: null,
      },
      raw: data,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown LinkedIn metrics error" };
  }
}

// --- TikTok ------------------------------------------------------------------
// POST /v2/video/query/ with a video ID filter. Requires the video.list scope;
// if the token lacks it the API returns an error we surface as a failure.
export async function fetchTikTokMetrics(accessToken: string, videoId: string): Promise<MetricsFetchResult> {
  try {
    const resp = await fetch(
      "https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ filters: { video_ids: [videoId] } }),
      },
    );
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `TikTok metrics error (${resp.status}): ${body}`, httpStatus: resp.status };
    }
    const data = await resp.json() as {
      data?: { videos?: Array<{ id?: string; like_count?: number; comment_count?: number; share_count?: number; view_count?: number }> };
      error?: { code?: string; message?: string };
    };
    if (data.error && data.error.code !== "ok") {
      return { success: false, error: `TikTok metrics API error: ${data.error.message || data.error.code}`, raw: data };
    }
    const video = data.data?.videos?.find(v => v.id === videoId) || data.data?.videos?.[0];
    if (!video) {
      return { success: false, error: "TikTok metrics: video not found in query response", raw: data };
    }
    return {
      success: true,
      metrics: {
        impressions: null,
        views: toCount(video.view_count),
        likes: toCount(video.like_count),
        comments: toCount(video.comment_count),
        shares: toCount(video.share_count),
      },
      raw: data,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown TikTok metrics error" };
  }
}

// --- YouTube -----------------------------------------------------------------
// GET /youtube/v3/videos?part=statistics. likeCount/commentCount can be hidden
// per-video, in which case the API omits them and we report null.
export async function fetchYouTubeMetrics(accessToken: string, videoId: string): Promise<MetricsFetchResult> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, error: `YouTube metrics error (${resp.status}): ${body}`, httpStatus: resp.status };
    }
    const data = await resp.json() as {
      items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }>;
    };
    const stats = data.items?.[0]?.statistics;
    if (!stats) {
      return { success: false, error: "YouTube metrics: video not found or statistics unavailable", raw: data };
    }
    return {
      success: true,
      metrics: {
        impressions: null,
        views: toCount(stats.viewCount),
        likes: toCount(stats.likeCount),
        comments: toCount(stats.commentCount),
        shares: null,
      },
      raw: data,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown YouTube metrics error" };
  }
}

// Dispatch on the calendar entry platform value (instagram_feed/instagram_story
// share the instagram fetcher). Returns a failure result for unknown platforms
// rather than throwing.
export async function fetchMetricsForPlatform(
  platform: string,
  accessToken: string,
  platformPostId: string,
): Promise<MetricsFetchResult> {
  switch (platform) {
    case "twitter":
      return fetchTwitterMetrics(accessToken, platformPostId);
    case "instagram_feed":
    case "instagram_story":
    case "instagram":
      return fetchInstagramMetrics(accessToken, platformPostId);
    case "linkedin":
      return fetchLinkedInMetrics(accessToken, platformPostId);
    case "tiktok":
      return fetchTikTokMetrics(accessToken, platformPostId);
    case "youtube":
      return fetchYouTubeMetrics(accessToken, platformPostId);
    default:
      return { success: false, error: `Metrics not supported for platform: ${platform}` };
  }
}

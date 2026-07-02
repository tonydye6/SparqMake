import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchTwitterMetrics,
  fetchInstagramMetrics,
  fetchLinkedInMetrics,
  fetchTikTokMetrics,
  fetchYouTubeMetrics,
  fetchMetricsForPlatform,
} from "./post-metrics-fetchers";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function mockFetchSequence(responses: Array<{ body: unknown; status?: number }>): void {
  const fn = vi.fn();
  for (const r of responses) {
    const status = r.status ?? 200;
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  vi.stubGlobal("fetch", fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTwitterMetrics", () => {
  it("normalizes public_metrics, combining retweets + quotes into shares", async () => {
    mockFetchOnce({
      data: {
        public_metrics: {
          retweet_count: 3,
          reply_count: 2,
          like_count: 10,
          quote_count: 1,
          impression_count: 500,
        },
      },
    });
    const result = await fetchTwitterMetrics("tok", "123");
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual({ impressions: 500, likes: 10, comments: 2, shares: 4 });
  });

  it("reports null impressions when impression_count is absent", async () => {
    mockFetchOnce({ data: { public_metrics: { like_count: 5, reply_count: 0, retweet_count: 0, quote_count: 0 } } });
    const result = await fetchTwitterMetrics("tok", "123");
    expect(result.success).toBe(true);
    expect(result.metrics?.impressions).toBeNull();
    expect(result.metrics?.likes).toBe(5);
    expect(result.metrics?.comments).toBe(0);
  });

  it("surfaces the http status on API errors", async () => {
    mockFetchOnce({ title: "Too Many Requests" }, 429);
    const result = await fetchTwitterMetrics("tok", "123");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(429);
  });
});

describe("fetchInstagramMetrics", () => {
  it("combines media fields with insights", async () => {
    mockFetchSequence([
      { body: { like_count: 7, comments_count: 2 } },
      { body: { data: [
        { name: "impressions", values: [{ value: 300 }] },
        { name: "reach", values: [{ value: 250 }] },
        { name: "shares", values: [{ value: 4 }] },
      ] } },
    ]);
    const result = await fetchInstagramMetrics("tok", "media1");
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual({ impressions: 300, views: null, likes: 7, comments: 2, shares: 4 });
  });

  it("degrades to basic counts when insights are unavailable", async () => {
    mockFetchSequence([
      { body: { like_count: 7, comments_count: 2 } },
      { body: { error: { message: "insights unsupported" } }, status: 400 },
    ]);
    const result = await fetchInstagramMetrics("tok", "media1");
    expect(result.success).toBe(true);
    expect(result.metrics?.likes).toBe(7);
    expect(result.metrics?.impressions).toBeNull();
  });

  it("falls back to reach when impressions metric is missing", async () => {
    mockFetchSequence([
      { body: { like_count: 1, comments_count: 0 } },
      { body: { data: [{ name: "reach", values: [{ value: 90 }] }] } },
    ]);
    const result = await fetchInstagramMetrics("tok", "media1");
    expect(result.metrics?.impressions).toBe(90);
  });
});

describe("fetchLinkedInMetrics", () => {
  it("maps social actions to likes/comments and nulls impressions", async () => {
    mockFetchOnce({
      likesSummary: { totalLikes: 12 },
      commentsSummary: { aggregatedTotalComments: 3 },
    });
    const result = await fetchLinkedInMetrics("tok", "urn:li:share:1");
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual({ impressions: null, views: null, likes: 12, comments: 3, shares: null });
  });
});

describe("fetchTikTokMetrics", () => {
  it("normalizes video query counts", async () => {
    mockFetchOnce({
      data: { videos: [{ id: "v1", like_count: 20, comment_count: 5, share_count: 2, view_count: 1000 }] },
      error: { code: "ok" },
    });
    const result = await fetchTikTokMetrics("tok", "v1");
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual({ impressions: null, views: 1000, likes: 20, comments: 5, shares: 2 });
  });

  it("fails when the video is not in the response", async () => {
    mockFetchOnce({ data: { videos: [] }, error: { code: "ok" } });
    const result = await fetchTikTokMetrics("tok", "v1");
    expect(result.success).toBe(false);
  });
});

describe("fetchYouTubeMetrics", () => {
  it("normalizes statistics and nulls hidden counts", async () => {
    mockFetchOnce({ items: [{ statistics: { viewCount: "1500", commentCount: "9" } }] });
    const result = await fetchYouTubeMetrics("tok", "vid1");
    expect(result.success).toBe(true);
    expect(result.metrics).toEqual({ impressions: null, views: 1500, likes: null, comments: 9, shares: null });
  });

  it("fails when the video is missing", async () => {
    mockFetchOnce({ items: [] });
    const result = await fetchYouTubeMetrics("tok", "vid1");
    expect(result.success).toBe(false);
  });
});

describe("fetchMetricsForPlatform", () => {
  it("routes instagram_feed and instagram_story to the instagram fetcher", async () => {
    mockFetchSequence([
      { body: { like_count: 1, comments_count: 0 } },
      { body: { data: [] } },
    ]);
    const result = await fetchMetricsForPlatform("instagram_story", "tok", "m1");
    expect(result.success).toBe(true);
  });

  it("returns a failure for unsupported platforms without throwing", async () => {
    const result = await fetchMetricsForPlatform("myspace", "tok", "p1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("myspace");
  });
});

import { apiFetch } from "@/lib/utils";
import { useState, useEffect } from "react";
import { Eye, Heart, MessageCircle, Share2, TrendingUp, BarChart3, Calendar as CalendarIcon, Trophy } from "lucide-react";
import { FaInstagram, FaXTwitter, FaTiktok, FaLinkedin, FaYoutube } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface PlatformBreakdown {
  platform: string;
  posts: number;
  postsWithMetrics: number;
  impressions: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagements: number;
}

interface DailyPoint {
  date: string;
  posts: number;
  impressions: number;
  engagements: number;
}

interface PostMetrics {
  impressions: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  fetchedAt: string;
}

interface PostRow {
  calendarEntryId: string;
  platform: string;
  publishedAt: string | null;
  platformPostId: string | null;
  creativeId: string;
  creativeName: string;
  brandId: string;
  templateId: string | null;
  caption: string | null;
  imageUrl: string | null;
  metrics: PostMetrics | null;
  engagements: number | null;
}

interface PerformanceSummary {
  totalPosts: number;
  postsWithMetrics: number;
  totals: {
    impressions: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    engagements: number;
  };
  byPlatform: PlatformBreakdown[];
  daily: DailyPoint[];
  topPosts: PostRow[];
  posts: PostRow[];
}

interface BrandOption {
  id: string;
  name: string;
}

interface TemplateOption {
  id: string;
  name: string;
}

const PLATFORM_ICONS: Record<string, IconType> = {
  instagram: FaInstagram,
  instagram_feed: FaInstagram,
  instagram_story: FaInstagram,
  twitter: FaXTwitter,
  tiktok: FaTiktok,
  linkedin: FaLinkedin,
  youtube: FaYoutube,
};

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X (Twitter)",
  instagram_feed: "Instagram Feed",
  instagram_story: "Instagram Story",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

const PLATFORM_COLORS: Record<string, string> = {
  twitter: "#8899A6",
  instagram_feed: "#E1306C",
  instagram_story: "#F77737",
  linkedin: "#0A66C2",
  tiktok: "#00F2EA",
  youtube: "#FF0000",
};

const PLATFORM_FILTERS = ["twitter", "instagram_feed", "instagram_story", "linkedin", "tiktok", "youtube"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function metricOrDash(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : fmt(v);
}

export default function PerformanceDashboard() {
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [brandFilter, setBrandFilter] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [templateFilter, setTemplateFilter] = useState<string>("");
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);

  useEffect(() => {
    apiFetch(`${API_BASE}/api/brands`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const arr = data?.data || data || [];
        if (Array.isArray(arr)) setBrands(arr.map((b: { id: string; name: string }) => ({ id: b.id, name: b.name })));
      })
      .catch(() => {});
    apiFetch(`${API_BASE}/api/templates`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const arr = data?.data || data || [];
        if (Array.isArray(arr)) setTemplates(arr.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const now = new Date();
        const params = new URLSearchParams();
        if (dateRange !== "all") {
          const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
          const d = new Date(now);
          d.setDate(d.getDate() - days);
          params.set("startDate", d.toISOString());
          params.set("endDate", now.toISOString());
        }
        if (brandFilter) params.set("brandId", brandFilter);
        if (platformFilter) params.set("platform", platformFilter);
        if (templateFilter) params.set("templateId", templateFilter);

        const resp = await apiFetch(`${API_BASE}/api/post-metrics/summary?${params}`);
        if (resp.ok) setSummary(await resp.json());
      } catch {}
      setIsLoading(false);
    };
    loadData();
  }, [dateRange, brandFilter, platformFilter, templateFilter]);

  if (isLoading && !summary) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-3 sm:p-6 max-w-[1200px] mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-xl sm:text-3xl font-bold text-foreground">Performance</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">See how your published posts perform across platforms.</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 sm:h-24 bg-card" />)}
        </div>
        <Skeleton className="h-[300px] bg-card" />
      </div>
    );
  }

  const maxDailyEngagement = Math.max(...(summary?.daily.map(d => d.engagements) || [0]), 1);
  const maxPlatformEngagement = Math.max(...(summary?.byPlatform.map(p => p.engagements) || [0]), 1);

  return (
    <div className="flex flex-col h-full overflow-hidden p-3 sm:p-6 max-w-[1200px] mx-auto w-full">
      <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center justify-between shrink-0 gap-3">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-foreground">Performance</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">See how your published posts perform across platforms.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["7d", "30d", "90d", "all"] as const).map(range => (
            <Button
              key={range}
              variant={dateRange === range ? "default" : "outline"}
              size="sm"
              className="text-xs sm:text-sm"
              onClick={() => setDateRange(range)}
            >
              {range === "all" ? "All Time" : range}
            </Button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 shrink-0">
        <select
          value={brandFilter}
          onChange={e => setBrandFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          <option value="">All brands</option>
          {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select
          value={platformFilter}
          onChange={e => setPlatformFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          <option value="">All platforms</option>
          {PLATFORM_FILTERS.map(p => <option key={p} value={p}>{PLATFORM_LABELS[p] || p}</option>)}
        </select>
        <select
          value={templateFilter}
          onChange={e => setTemplateFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          <option value="">All templates</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto pr-0 sm:pr-2 pb-12">
        {!isLoading && (!summary || summary.totalPosts === 0) && (
          <EmptyState
            icon={TrendingUp}
            title="No performance data yet"
            description="Metrics appear here after posts are published and their stats are collected"
            className="mb-6"
          />
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-4 sm:mb-6">
          <SummaryCard
            icon={<Eye size={18} />}
            label="Impressions + Views"
            value={fmt((summary?.totals.impressions || 0) + (summary?.totals.views || 0))}
            color="text-primary"
          />
          <SummaryCard
            icon={<Heart size={18} />}
            label="Likes"
            value={fmt(summary?.totals.likes || 0)}
            color="text-red-400"
          />
          <SummaryCard
            icon={<TrendingUp size={18} />}
            label="Engagements"
            value={fmt(summary?.totals.engagements || 0)}
            color="text-green-400"
          />
          <SummaryCard
            icon={<BarChart3 size={18} />}
            label="Posts Tracked"
            value={`${summary?.postsWithMetrics || 0}/${summary?.totalPosts || 0}`}
            color="text-amber-400"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-4 sm:mb-6">
          <div className="lg:col-span-2 bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              <CalendarIcon size={16} className="text-primary" /> Daily Engagement
            </h3>
            {summary?.daily && summary.daily.length > 0 ? (
              <div className="flex items-end gap-0.5 sm:gap-1 h-[150px] sm:h-[180px]">
                {summary.daily.map((day, i) => {
                  const height = Math.max((day.engagements / maxDailyEngagement) * 100, 2);
                  const date = new Date(day.date + "T00:00:00");
                  const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  return (
                    <div key={i} className="flex-1 h-full flex flex-col items-center justify-end group relative min-w-0">
                      <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-background border border-border rounded px-2 py-1 text-[10px] text-foreground opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                        {fmt(day.engagements)} engagements · {fmt(day.impressions)} impressions ({day.posts} posts)
                      </div>
                      <div
                        className="w-full bg-primary/80 rounded-t hover:bg-primary transition-colors min-h-[2px]"
                        style={{ height: `${height}%` }}
                      />
                      {summary.daily.length <= 14 && (
                        <span className="text-[8px] sm:text-[9px] text-muted-foreground mt-1 truncate w-full text-center hidden sm:block">{label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-[150px] sm:h-[180px] flex items-center justify-center text-muted-foreground text-sm">
                No engagement data for this period
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Engagement by Platform</h3>
            <div className="space-y-4">
              {summary?.byPlatform.map(p => {
                const pct = (p.engagements / maxPlatformEngagement) * 100;
                const color = PLATFORM_COLORS[p.platform] || "#666";
                const Icon = PLATFORM_ICONS[p.platform];
                return (
                  <div key={p.platform}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                        {Icon && <Icon size={12} />}
                        {PLATFORM_LABELS[p.platform] || p.platform}
                      </span>
                      <span className="text-xs text-muted-foreground">{fmt(p.engagements)}</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: color }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {p.postsWithMetrics}/{p.posts} posts tracked · {fmt(p.impressions + p.views)} impressions/views
                    </span>
                  </div>
                );
              })}
              {(!summary?.byPlatform || summary.byPlatform.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No data</p>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              <Trophy size={16} className="text-amber-400" /> Top Posts
            </h3>
            <div className="space-y-2">
              {summary?.topPosts.map(post => {
                const Icon = PLATFORM_ICONS[post.platform];
                return (
                  <div key={post.calendarEntryId} className="flex items-center justify-between p-2 bg-background rounded-lg border border-border gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {Icon && <Icon size={14} className="shrink-0" style={{ color: PLATFORM_COLORS[post.platform] || undefined }} />}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{post.creativeName}</p>
                        {post.caption && <p className="text-[10px] text-muted-foreground truncate">{post.caption}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-0.5"><Eye size={10} />{metricOrDash(post.metrics?.impressions ?? post.metrics?.views)}</span>
                      <span className="flex items-center gap-0.5"><Heart size={10} />{metricOrDash(post.metrics?.likes)}</span>
                      <span className="flex items-center gap-0.5"><MessageCircle size={10} />{metricOrDash(post.metrics?.comments)}</span>
                      <span className="flex items-center gap-0.5"><Share2 size={10} />{metricOrDash(post.metrics?.shares)}</span>
                    </div>
                  </div>
                );
              })}
              {(!summary?.topPosts || summary.topPosts.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No tracked posts yet</p>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-4 sm:p-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Recent Published Posts</h3>
            <div className="space-y-1 max-h-[340px] overflow-y-auto">
              {summary?.posts.map(post => {
                const Icon = PLATFORM_ICONS[post.platform];
                return (
                  <div key={post.calendarEntryId} className="flex items-center justify-between p-2 text-xs border-b border-border last:border-0 gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {Icon && <Icon size={12} className="shrink-0" style={{ color: PLATFORM_COLORS[post.platform] || undefined }} />}
                      <span className="text-foreground truncate">{post.creativeName}</span>
                      {!post.metrics && <Badge variant="outline" className="text-[9px] shrink-0">awaiting metrics</Badge>}
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-[10px] text-muted-foreground">
                      {post.metrics && (
                        <>
                          <span className="flex items-center gap-0.5"><Eye size={10} />{metricOrDash(post.metrics.impressions ?? post.metrics.views)}</span>
                          <span className="flex items-center gap-0.5"><Heart size={10} />{metricOrDash(post.metrics.likes)}</span>
                        </>
                      )}
                      <span className="hidden sm:inline">
                        {post.publishedAt && new Date(post.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                );
              })}
              {(!summary?.posts || summary.posts.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No published posts in this period</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3 sm:p-5">
      <div className={`${color} mb-1 sm:mb-2`}>{icon}</div>
      <div className="text-lg sm:text-2xl font-bold text-foreground">{value}</div>
      <div className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

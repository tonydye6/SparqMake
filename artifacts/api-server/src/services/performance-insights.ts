import { eq, and, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  calendarEntriesTable,
  creativesTable,
  creativeVariantsTable,
  postMetricsTable,
  signalsTable,
} from "@workspace/db";
import { INTENT_LABELS, isIntent, type Intent } from "../lib/intents.js";
import { logger } from "../lib/logger";

// Intent-aware performance analysis: aggregates the latest metric snapshot of
// each published post by intent, platform, and time-of-day, and produces
// concise recommendation records with explicit confidence. This is the first
// registered "signals" source (sourceType "performance") — computed insights
// are mirrored into the signals table so future consumers can read them the
// same way as telemetry or news signals.

export const PERFORMANCE_SIGNAL_SOURCE = "performance";
export const INTENT_PERFORMANCE_KIND = "intent_performance";

// Sample-size → confidence mapping. Kept deliberately conservative so the UI
// never fakes certainty on thin data.
export type ConfidenceLevel = "none" | "low" | "medium" | "high";
export function confidenceForSample(posts: number): ConfidenceLevel {
  if (posts <= 0) return "none";
  if (posts < 3) return "low";
  if (posts < 10) return "medium";
  return "high";
}

// Coarse posting-time buckets (server-local hours). Coarse on purpose: with
// small samples, hour-level precision would be noise dressed up as insight.
const DAY_PARTS: { key: string; label: string; from: number; to: number }[] = [
  { key: "morning", label: "mornings (5am–11am)", from: 5, to: 11 },
  { key: "midday", label: "midday (11am–2pm)", from: 11, to: 14 },
  { key: "afternoon", label: "afternoons (2pm–5pm)", from: 14, to: 17 },
  { key: "evening", label: "evenings (5pm–10pm)", from: 17, to: 22 },
  { key: "night", label: "late night (10pm–5am)", from: 22, to: 29 },
];

export function dayPartForHour(hour: number): { key: string; label: string } {
  const h = hour < 5 ? hour + 24 : hour;
  const part = DAY_PARTS.find(p => h >= p.from && h < p.to) || DAY_PARTS[4];
  return { key: part.key, label: part.label };
}

// Default suggested hour per day-part, for schedule suggestions.
const DAY_PART_SUGGESTED_HOUR: Record<string, number> = {
  morning: 9,
  midday: 12,
  afternoon: 15,
  evening: 18,
  night: 22,
};

export interface PlatformInsight {
  platform: string;
  posts: number;
  totalEngagements: number;
  avgEngagement: number;
  // Relative emphasis 0..1 against the best platform (best = 1).
  emphasis: number;
}

export interface TimeInsight {
  dayPart: string;
  dayPartLabel: string;
  suggestedHour: number;
  posts: number;
  avgEngagement: number;
}

export interface ReferencePost {
  calendarEntryId: string;
  creativeId: string;
  creativeName: string;
  platform: string;
  publishedAt: Date | null;
  caption: string | null;
  imageUrl: string | null;
  engagements: number;
}

export interface IntentInsights {
  intent: string | null;
  intentLabel: string | null;
  sampleSize: number;
  confidence: ConfidenceLevel;
  platforms: PlatformInsight[];
  bestTimes: TimeInsight[];
  topPosts: ReferencePost[];
  // Plain-language reasoning lines; always present, honest about low data.
  reasoning: string[];
}

interface ScoredPost {
  calendarEntryId: string;
  creativeId: string;
  creativeName: string;
  platform: string;
  publishedAt: Date | null;
  caption: string | null;
  imageUrl: string | null;
  intent: string | null;
  engagements: number;
}

// Load every published post (optionally brand-scoped) that has at least one
// metric snapshot, scored by its latest snapshot's engagement.
async function loadScoredPosts(brandId?: string): Promise<ScoredPost[]> {
  const conditions = [
    eq(calendarEntriesTable.publishStatus, "published"),
    isNotNull(calendarEntriesTable.publishedAt),
  ];
  if (brandId) conditions.push(eq(creativesTable.brandId, brandId));

  const entries = await db
    .select({
      id: calendarEntriesTable.id,
      platform: calendarEntriesTable.platform,
      publishedAt: calendarEntriesTable.publishedAt,
      intent: calendarEntriesTable.intent,
      creativeId: calendarEntriesTable.creativeId,
      creativeName: creativesTable.name,
      creativeIntent: creativesTable.intent,
      caption: creativeVariantsTable.caption,
      imageUrl: creativeVariantsTable.compositedImageUrl,
    })
    .from(calendarEntriesTable)
    .innerJoin(creativesTable, eq(calendarEntriesTable.creativeId, creativesTable.id))
    .leftJoin(creativeVariantsTable, eq(calendarEntriesTable.variantId, creativeVariantsTable.id))
    .where(and(...conditions));

  if (entries.length === 0) return [];

  const latest = await db
    .selectDistinctOn([postMetricsTable.calendarEntryId], {
      calendarEntryId: postMetricsTable.calendarEntryId,
      likes: postMetricsTable.likes,
      comments: postMetricsTable.comments,
      shares: postMetricsTable.shares,
    })
    .from(postMetricsTable)
    .where(inArray(postMetricsTable.calendarEntryId, entries.map(e => e.id)))
    .orderBy(postMetricsTable.calendarEntryId, sql`${postMetricsTable.fetchedAt} DESC`);

  const metricMap = new Map(latest.map(m => [m.calendarEntryId, m]));

  const scored: ScoredPost[] = [];
  for (const entry of entries) {
    const m = metricMap.get(entry.id);
    if (!m) continue; // no snapshot yet — nothing to learn from
    scored.push({
      calendarEntryId: entry.id,
      creativeId: entry.creativeId,
      creativeName: entry.creativeName,
      platform: entry.platform,
      publishedAt: entry.publishedAt,
      caption: entry.caption ?? null,
      imageUrl: entry.imageUrl ?? null,
      // Entry-level intent snapshot wins; fall back to the creative's intent
      // for entries scheduled before intent copying existed.
      intent: entry.intent || entry.creativeIntent || null,
      engagements: (m.likes || 0) + (m.comments || 0) + (m.shares || 0),
    });
  }
  return scored;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const PLATFORM_DISPLAY: Record<string, string> = {
  twitter: "X (Twitter)",
  instagram_feed: "Instagram Feed",
  instagram_story: "Instagram Story",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

function platformName(p: string): string {
  return PLATFORM_DISPLAY[p] || p;
}

function buildInsights(posts: ScoredPost[], intent: string | null): IntentInsights {
  const label = intent && isIntent(intent) ? INTENT_LABELS[intent as Intent] : intent;
  const sampleSize = posts.length;
  const confidence = confidenceForSample(sampleSize);
  const intentPhrase = label ? `your ${label.toLowerCase()} posts` : "your posts";

  if (sampleSize === 0) {
    return {
      intent,
      intentLabel: label ?? null,
      sampleSize: 0,
      confidence,
      platforms: [],
      bestTimes: [],
      topPosts: [],
      reasoning: [
        label
          ? `No performance data yet for ${label.toLowerCase()} posts — recommendations will appear once a few are published and tracked.`
          : "No performance data yet — recommendations will appear once a few posts are published and tracked.",
      ],
    };
  }

  // Platform aggregation.
  const byPlatform = new Map<string, { posts: number; total: number }>();
  for (const p of posts) {
    const agg = byPlatform.get(p.platform) || { posts: 0, total: 0 };
    agg.posts += 1;
    agg.total += p.engagements;
    byPlatform.set(p.platform, agg);
  }
  const platformInsights: PlatformInsight[] = Array.from(byPlatform.entries())
    .map(([platform, agg]) => ({
      platform,
      posts: agg.posts,
      totalEngagements: agg.total,
      avgEngagement: round1(agg.total / agg.posts),
      emphasis: 0,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);
  const bestAvg = platformInsights[0]?.avgEngagement || 0;
  for (const pi of platformInsights) {
    pi.emphasis = bestAvg > 0 ? round1(pi.avgEngagement / bestAvg * 10) / 10 : 0;
  }

  // Time-of-day aggregation.
  const byPart = new Map<string, { label: string; posts: number; total: number }>();
  for (const p of posts) {
    if (!p.publishedAt) continue;
    const part = dayPartForHour(p.publishedAt.getHours());
    const agg = byPart.get(part.key) || { label: part.label, posts: 0, total: 0 };
    agg.posts += 1;
    agg.total += p.engagements;
    byPart.set(part.key, agg);
  }
  const bestTimes: TimeInsight[] = Array.from(byPart.entries())
    .map(([key, agg]) => ({
      dayPart: key,
      dayPartLabel: agg.label,
      suggestedHour: DAY_PART_SUGGESTED_HOUR[key] ?? 12,
      posts: agg.posts,
      avgEngagement: round1(agg.total / agg.posts),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  const topPosts: ReferencePost[] = [...posts]
    .sort((a, b) => b.engagements - a.engagements)
    .slice(0, 5)
    .map(({ intent: _i, ...rest }) => rest);

  // Plain-language reasoning, honest about sample size.
  const reasoning: string[] = [];
  if (confidence === "low") {
    reasoning.push(
      `Only ${sampleSize} tracked ${sampleSize === 1 ? "post" : "posts"} so far — treat these as early hints, not conclusions.`,
    );
  }
  const top = platformInsights[0];
  if (top && top.totalEngagements > 0) {
    const timePart = bestTimes[0] && bestTimes[0].avgEngagement > 0 ? `, ${bestTimes[0].dayPartLabel.split(" (")[0]}` : "";
    reasoning.push(
      `${intentPhrase[0].toUpperCase()}${intentPhrase.slice(1)} do best on ${platformName(top.platform)}${timePart} (avg ${top.avgEngagement} engagements over ${top.posts} ${top.posts === 1 ? "post" : "posts"}).`,
    );
    const runnerUp = platformInsights[1];
    if (runnerUp && runnerUp.totalEngagements > 0) {
      reasoning.push(
        `${platformName(runnerUp.platform)} is a solid second (avg ${runnerUp.avgEngagement} engagements).`,
      );
    }
  } else {
    reasoning.push(`Tracked ${intentPhrase} have not registered engagement yet — defaults apply until they do.`);
  }

  return { intent, intentLabel: label ?? null, sampleSize, confidence, platforms: platformInsights, bestTimes, topPosts, reasoning };
}

// Main entry: insights for one intent (or all posts when intent is null),
// optionally brand-scoped.
export async function getIntentInsights(options: {
  brandId?: string;
  intent?: string | null;
}): Promise<IntentInsights> {
  const all = await loadScoredPosts(options.brandId);
  const posts = options.intent ? all.filter(p => p.intent === options.intent) : all;
  return buildInsights(posts, options.intent ?? null);
}

// Per-intent breakdown across every intent present in the data (for the
// performance dashboard's intent dimension).
export async function getInsightsByIntent(brandId?: string): Promise<IntentInsights[]> {
  const all = await loadScoredPosts(brandId);
  const intents = new Map<string, ScoredPost[]>();
  for (const p of all) {
    const key = p.intent || "__none__";
    const list = intents.get(key) || [];
    list.push(p);
    intents.set(key, list);
  }
  return Array.from(intents.entries())
    .map(([key, posts]) => buildInsights(posts, key === "__none__" ? null : key))
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

// Mirror computed insights into the signals table (the "performance" source).
// Upserts one signal per brand+intent via dedupeKey, valid for 7 days, so the
// generic signals API always has fresh performance-derived rows alongside
// whatever future sources (telemetry, news) write. Never throws — signal
// mirroring must not break the recommendation path.
const SIGNAL_TTL_MS = 7 * 24 * 60 * 60_000;

export async function syncPerformanceSignals(brandId?: string): Promise<void> {
  try {
    const insights = await getInsightsByIntent(brandId);
    const now = new Date();
    for (const ins of insights) {
      if (ins.sampleSize === 0) continue;
      const dedupeKey = `${brandId || "global"}:${ins.intent || "none"}`;
      const values = {
        sourceType: PERFORMANCE_SIGNAL_SOURCE,
        kind: INTENT_PERFORMANCE_KIND,
        brandId: brandId || null,
        title: ins.reasoning.find(r => !r.startsWith("Only")) || ins.reasoning[0],
        payload: {
          intent: ins.intent,
          sampleSize: ins.sampleSize,
          confidence: ins.confidence,
          platforms: ins.platforms,
          bestTimes: ins.bestTimes,
        },
        strength: ins.confidence === "high" ? 0.9 : ins.confidence === "medium" ? 0.6 : 0.3,
        relevantFrom: now,
        relevantUntil: new Date(now.getTime() + SIGNAL_TTL_MS),
        dedupeKey,
        updatedAt: now,
      };
      await db.insert(signalsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [signalsTable.sourceType, signalsTable.dedupeKey],
          set: {
            title: values.title,
            payload: values.payload,
            strength: values.strength,
            relevantFrom: values.relevantFrom,
            relevantUntil: values.relevantUntil,
            brandId: values.brandId,
            updatedAt: now,
          },
        });
    }
  } catch (err) {
    logger.warn({ err }, "Performance signal sync failed (non-fatal)");
  }
}

import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, and, gte, lte, ne, sql } from "drizzle-orm";
import {
  db,
  brandsTable,
  brandScheduleProfilesTable,
  creativesTable,
  creativeVariantsTable,
  calendarEntriesTable,
  smartScheduleProposalsTable,
} from "@workspace/db";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";

const router: IRouter = Router();

const PLATFORM_MAP: Record<string, string> = {
  instagram: "instagram_feed",
  instagram_feed: "instagram_feed",
  instagram_story: "instagram_story",
  twitter: "twitter",
  x: "twitter",
  linkedin: "linkedin",
  tiktok: "tiktok",
  facebook: "twitter",
  youtube: "twitter",
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram_feed: "Instagram Feed",
  instagram_story: "Instagram Story",
  twitter: "X/Twitter",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
};

const PLATFORM_PEAK_HOURS: Record<string, number[]> = {
  instagram_feed: [9, 11, 12, 17, 18, 19, 20],
  instagram_story: [8, 9, 12, 17, 18, 19, 20, 21],
  twitter: [8, 9, 12, 13, 17, 18],
  linkedin: [7, 8, 9, 10, 12, 17],
  tiktok: [10, 11, 12, 19, 20, 21, 22],
};

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface SlotCandidate {
  day: number;
  hour: number;
  score: number;
  date: Date;
  rationale: string;
}

interface ScheduledSlot {
  platform: string;
  date: Date;
}

const MIN_PLATFORM_GAP_HOURS = 2;
const MIN_CROSS_PLATFORM_GAP_HOURS = 1;
const PRIMARY_WINDOW_DAYS = 7;
const EXTENDED_WINDOW_DAYS = 14;

function getProfilePlatform(platform: string): string {
  return PLATFORM_MAP[platform.toLowerCase()] || "twitter";
}

function hasConflict(
  candidateDate: Date,
  platform: string,
  existingSlots: ScheduledSlot[],
): boolean {
  const candidateTime = candidateDate.getTime();
  const samePlatformGapMs = MIN_PLATFORM_GAP_HOURS * 60 * 60 * 1000;
  const crossPlatformGapMs = MIN_CROSS_PLATFORM_GAP_HOURS * 60 * 60 * 1000;

  for (const slot of existingSlots) {
    const diff = Math.abs(slot.date.getTime() - candidateTime);
    if (slot.platform === platform) {
      if (diff < samePlatformGapMs) return true;
    } else {
      if (diff < crossPlatformGapMs) return true;
    }
  }
  return false;
}

function buildCandidateSlots(
  profileSlots: { dayOfWeek: number; hour: number; score: number; status: string }[],
  startDate: Date,
  windowDays: number,
): SlotCandidate[] {
  const slotMap = new Map<string, { score: number; status: string }>();
  for (const s of profileSlots) {
    slotMap.set(`${s.dayOfWeek}-${s.hour}`, { score: s.score, status: s.status });
  }

  const candidates: SlotCandidate[] = [];
  const now = new Date();

  for (let d = 0; d < windowDays; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dayOfWeek = date.getDay();

    for (let hour = 0; hour <= 23; hour++) {
      const key = `${dayOfWeek}-${hour}`;
      const slotInfo = slotMap.get(key);
      const score = slotInfo?.score ?? 0.3;
      const status = slotInfo?.status ?? "acceptable";

      if (status === "blocked") continue;

      const candidateDate = new Date(date);
      candidateDate.setHours(hour, 0, 0, 0);

      if (candidateDate <= now) continue;

      let rationale = "";
      if (score >= 0.7) {
        rationale = `Preferred slot (score ${(score * 100).toFixed(0)}%) — peak engagement window`;
      } else if (score >= 0.5) {
        rationale = `Good slot (score ${(score * 100).toFixed(0)}%) — solid engagement expected`;
      } else {
        rationale = `Acceptable slot (score ${(score * 100).toFixed(0)}%) — moderate engagement`;
      }

      candidates.push({ day: dayOfWeek, hour, score, date: candidateDate, rationale });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function buildFallbackCandidateSlots(
  platform: string,
  startDate: Date,
  days: number,
): SlotCandidate[] {
  const peaks = PLATFORM_PEAK_HOURS[platform] || [9, 12, 17];
  const candidates: SlotCandidate[] = [];
  const now = new Date();

  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const dayOfWeek = date.getDay();
    const dayLabel = DAY_LABELS[dayOfWeek];
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    for (const hour of peaks) {
      let score = 0.5;
      const reasons: string[] = [];

      score += 0.3;
      reasons.push(`${hour > 12 ? hour - 12 : hour}${hour >= 12 ? "PM" : "AM"} is a peak engagement hour for ${PLATFORM_LABELS[platform] || platform}`);

      if (isWeekend && ["instagram_feed", "instagram_story", "tiktok"].includes(platform)) {
        score += 0.1;
        reasons.push(`Weekend posting tends to perform well on ${PLATFORM_LABELS[platform] || platform}`);
      } else if (!isWeekend && ["linkedin", "twitter"].includes(platform)) {
        score += 0.1;
        reasons.push(`Weekday posting is optimal for ${PLATFORM_LABELS[platform] || platform}`);
      }

      if (d < 2) {
        score += 0.05;
        reasons.push("Sooner posting captures momentum");
      }

      score = Math.min(1, score);
      const slotDate = new Date(date);
      slotDate.setHours(hour, 0, 0, 0);

      if (slotDate <= now) continue;

      candidates.push({
        day: dayOfWeek,
        hour,
        score: Math.round(score * 100) / 100,
        date: slotDate,
        rationale: `${dayLabel}: ${reasons.join(". ")}.`,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function findBestSlot(
  candidates: SlotCandidate[],
  platform: string,
  occupiedSlots: ScheduledSlot[],
  extendedCandidates?: SlotCandidate[],
): { slot: SlotCandidate; extended: boolean; conflictNote?: string } | null {
  for (const c of candidates) {
    if (!hasConflict(c.date, platform, occupiedSlots)) {
      return { slot: c, extended: false };
    }
  }

  if (extendedCandidates) {
    for (const c of extendedCandidates) {
      if (!hasConflict(c.date, platform, occupiedSlots)) {
        return {
          slot: c,
          extended: true,
          conflictNote: "All slots within 7 days had conflicts — extended to 14-day window",
        };
      }
    }
  }

  return null;
}

const BatchSmartScheduleBody = z.object({
  creativeIds: z.array(z.string().min(1)).min(1),
});

router.post(
  "/smart-schedule/batch",
  validateRequest({ body: BatchSmartScheduleBody }),
  async (req, res): Promise<void> => {
    const { creativeIds } = req.body;

    const creatives = await db
      .select({
        id: creativesTable.id,
        name: creativesTable.name,
        brandId: creativesTable.brandId,
        status: creativesTable.status,
      })
      .from(creativesTable)
      .where(sql`${creativesTable.id} = ANY(${creativeIds})`);

    const creativeMap = new Map(creatives.map((c: { id: string; name: string; brandId: string; status: string }) => [c.id, c]));

    const notFound = creativeIds.filter((id: string) => !creativeMap.has(id));
    if (notFound.length > 0) {
      res.status(400).json({ error: `Creatives not found: ${notFound.join(", ")}` });
      return;
    }

    const notApproved = creatives.filter((c) => c.status !== "approved" && c.status !== "scheduled");
    if (notApproved.length > 0) {
      res.status(400).json({
        error: `Some creatives are not in approved/scheduled status: ${notApproved.map((c) => c.name).join(", ")}`,
      });
      return;
    }

    const allVariants = await db
      .select()
      .from(creativeVariantsTable)
      .where(sql`${creativeVariantsTable.creativeId} = ANY(${creativeIds})`);

    if (allVariants.length === 0) {
      res.status(400).json({ error: "No variants found for the provided creatives" });
      return;
    }

    const brandIds = [...new Set(creatives.map((c) => c.brandId))];
    const brandProfiles: Record<string, { dayOfWeek: number; hour: number; score: number; status: string }[]> = {};

    for (const brandId of brandIds) {
      const profiles = await db
        .select({
          platform: brandScheduleProfilesTable.platform,
          dayOfWeek: brandScheduleProfilesTable.dayOfWeek,
          hour: brandScheduleProfilesTable.hour,
          score: brandScheduleProfilesTable.score,
          status: brandScheduleProfilesTable.status,
        })
        .from(brandScheduleProfilesTable)
        .where(eq(brandScheduleProfilesTable.brandId, brandId));

      for (const p of profiles) {
        const key = `${brandId}:${p.platform}`;
        if (!brandProfiles[key]) brandProfiles[key] = [];
        brandProfiles[key].push(p);
      }
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() + 1);

    const windowEnd = new Date(startDate);
    windowEnd.setDate(windowEnd.getDate() + EXTENDED_WINDOW_DAYS);

    const existingEntries = await db
      .select({
        platform: calendarEntriesTable.platform,
        scheduledAt: calendarEntriesTable.scheduledAt,
      })
      .from(calendarEntriesTable)
      .where(
        and(
          gte(calendarEntriesTable.scheduledAt, startDate),
          lte(calendarEntriesTable.scheduledAt, windowEnd),
        ),
      );

    const occupiedSlots: ScheduledSlot[] = existingEntries.map((e) => ({
      platform: e.platform,
      date: new Date(e.scheduledAt),
    }));

    const proposals: Record<
      string,
      {
        creativeId: string;
        creativeName: string;
        variants: {
          variantId: string;
          platform: string;
          proposedAt: string;
          rationale: string;
          slotScore: number;
          extended: boolean;
          conflictNote?: string;
        }[];
      }
    > = {};

    for (const creativeId of creativeIds) {
      const creative = creativeMap.get(creativeId)!;
      const variants = allVariants.filter((v) => v.creativeId === creativeId);

      const creativeProposals: (typeof proposals)[string]["variants"] = [];

      for (const variant of variants) {
        const profilePlatform = getProfilePlatform(variant.platform);
        const profileKey = `${creative.brandId}:${profilePlatform}`;
        const profileSlots = brandProfiles[profileKey] || [];

        const hasBrandProfile = profileSlots.length > 0;
        const primaryCandidates = hasBrandProfile
          ? buildCandidateSlots(profileSlots, startDate, PRIMARY_WINDOW_DAYS)
          : buildFallbackCandidateSlots(variant.platform, startDate, PRIMARY_WINDOW_DAYS);
        const extendedCandidates = hasBrandProfile
          ? buildCandidateSlots(profileSlots, startDate, EXTENDED_WINDOW_DAYS)
          : buildFallbackCandidateSlots(variant.platform, startDate, EXTENDED_WINDOW_DAYS);

        const result = findBestSlot(primaryCandidates, variant.platform, occupiedSlots, extendedCandidates);

        if (result) {
          const { slot, extended, conflictNote } = result;

          let rationale = slot.rationale;
          if (conflictNote) {
            rationale = `${rationale}. ${conflictNote}`;
          }

          occupiedSlots.push({ platform: variant.platform, date: slot.date });

          const [proposal] = await db
            .insert(smartScheduleProposalsTable)
            .values({
              creativeId,
              variantId: variant.id,
              platform: variant.platform,
              proposedAt: slot.date,
              rationale,
              slotScore: slot.score,
              status: "pending",
            })
            .returning();

          creativeProposals.push({
            variantId: variant.id,
            platform: variant.platform,
            proposedAt: slot.date.toISOString(),
            rationale,
            slotScore: slot.score,
            extended,
            conflictNote,
          });
        } else {
          creativeProposals.push({
            variantId: variant.id,
            platform: variant.platform,
            proposedAt: "",
            rationale: "No available slots found within the scheduling window — all time slots have conflicts",
            slotScore: 0,
            extended: false,
            conflictNote: "No available slots within 14 days",
          });
        }
      }

      proposals[creativeId] = {
        creativeId,
        creativeName: creative.name,
        variants: creativeProposals,
      };
    }

    res.json({ proposals });
  },
);

router.post(
  "/creatives/:creativeId/smart-schedule",
  validateRequest({ params: z.object({ creativeId: z.string().min(1) }) }),
  async (req, res): Promise<void> => {
    const creativeId = str(req.params.creativeId);

    const creative = await db
      .select()
      .from(creativesTable)
      .where(eq(creativesTable.id, creativeId))
      .then((r) => r[0]);

    if (!creative) {
      res.status(404).json({ error: "Creative not found" });
      return;
    }

    const variants = await db
      .select()
      .from(creativeVariantsTable)
      .where(eq(creativeVariantsTable.creativeId, creativeId));

    if (variants.length === 0) {
      res.status(400).json({ error: "No variants found for this creative" });
      return;
    }

    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);

    const existingEntries = await db
      .select({
        scheduledAt: calendarEntriesTable.scheduledAt,
        platform: calendarEntriesTable.platform,
      })
      .from(calendarEntriesTable)
      .where(
        and(
          gte(calendarEntriesTable.scheduledAt, startDate),
          lte(calendarEntriesTable.scheduledAt, endDate),
          eq(calendarEntriesTable.publishStatus, "scheduled"),
        ),
      );

    const profilePlatform = getProfilePlatform(variants[0]?.platform || "twitter");
    const brandProfiles = await db
      .select({
        platform: brandScheduleProfilesTable.platform,
        dayOfWeek: brandScheduleProfilesTable.dayOfWeek,
        hour: brandScheduleProfilesTable.hour,
        score: brandScheduleProfilesTable.score,
        status: brandScheduleProfilesTable.status,
      })
      .from(brandScheduleProfilesTable)
      .where(eq(brandScheduleProfilesTable.brandId, creative.brandId));

    const profileMap: Record<string, { dayOfWeek: number; hour: number; score: number; status: string }[]> = {};
    for (const p of brandProfiles) {
      if (!profileMap[p.platform]) profileMap[p.platform] = [];
      profileMap[p.platform].push(p);
    }

    const occupiedSlots: ScheduledSlot[] = existingEntries.map((e) => ({
      platform: e.platform,
      date: new Date(e.scheduledAt),
    }));

    const proposals: Array<{
      variantId: string;
      platform: string;
      proposedAt: Date;
      score: number;
      rationale: string;
      hasConflict: boolean;
      conflictMessage: string;
    }> = [];

    for (const variant of variants) {
      const pp = getProfilePlatform(variant.platform);
      const profileSlots = profileMap[pp] || [];

      let candidates: SlotCandidate[];
      if (profileSlots.length > 0) {
        candidates = buildCandidateSlots(profileSlots, startDate, 7);
      } else {
        candidates = buildFallbackCandidateSlots(variant.platform, startDate, 7);
      }

      const result = findBestSlot(candidates, variant.platform, occupiedSlots);

      if (!result) continue;

      occupiedSlots.push({ platform: variant.platform, date: result.slot.date });

      const conflictCheck = existingEntries.some((entry) => {
        const timeDiff = Math.abs(result.slot.date.getTime() - new Date(entry.scheduledAt).getTime());
        return entry.platform === variant.platform && timeDiff < MIN_PLATFORM_GAP_HOURS * 60 * 60 * 1000;
      });

      proposals.push({
        variantId: variant.id,
        platform: variant.platform,
        proposedAt: result.slot.date,
        score: result.slot.score,
        rationale: result.slot.rationale,
        hasConflict: conflictCheck,
        conflictMessage: conflictCheck
          ? `Conflict: Another ${PLATFORM_LABELS[variant.platform] || variant.platform} post is scheduled within 2 hours`
          : "",
      });
    }

    await db
      .delete(smartScheduleProposalsTable)
      .where(
        and(
          eq(smartScheduleProposalsTable.creativeId, creativeId),
          eq(smartScheduleProposalsTable.status, "pending"),
        ),
      );

    const savedProposals = [];
    for (const p of proposals) {
      const [saved] = await db
        .insert(smartScheduleProposalsTable)
        .values({
          creativeId,
          variantId: p.variantId,
          platform: p.platform,
          proposedAt: p.proposedAt,
          slotScore: p.score,
          rationale: p.rationale,
          status: "pending",
        })
        .returning();

      savedProposals.push({
        ...saved,
        hasConflict: p.hasConflict,
        conflictMessage: p.conflictMessage,
      });
    }

    res.json({ proposals: savedProposals });
  },
);

router.get(
  "/smart-schedule/proposals/:creativeId",
  validateRequest({ params: z.object({ creativeId: z.string().min(1) }) }),
  async (req, res): Promise<void> => {
    const creativeId = str(req.params.creativeId);

    const proposals = await db
      .select()
      .from(smartScheduleProposalsTable)
      .where(eq(smartScheduleProposalsTable.creativeId, creativeId))
      .orderBy(smartScheduleProposalsTable.proposedAt);

    res.json({ proposals });
  },
);

const ConfirmSmartScheduleBody = z.object({
  proposals: z.array(
    z.object({
      creativeId: z.string().min(1),
      variantId: z.string().min(1),
      platform: z.string().min(1),
      scheduledAt: z.string().min(1),
      rationale: z.string().optional(),
      slotScore: z.number().optional(),
    }),
  ),
});

router.post(
  "/smart-schedule/confirm",
  validateRequest({ body: ConfirmSmartScheduleBody }),
  async (req, res): Promise<void> => {
    const { proposals: proposalInputs } = req.body;

    const variantIds = proposalInputs.map((p: { variantId: string }) => p.variantId);
    const existingProposals = await db
      .select()
      .from(smartScheduleProposalsTable)
      .where(sql`${smartScheduleProposalsTable.variantId} = ANY(${variantIds}) AND ${smartScheduleProposalsTable.status} = 'pending'`);

    const proposalMap = new Map(
      existingProposals.map((p) => [`${p.creativeId}:${p.variantId}`, p]),
    );

    const created: (typeof calendarEntriesTable.$inferSelect)[] = [];
    const creativesScheduled: string[] = [];
    const creativeIdSet = new Set<string>();
    const conflicts: string[] = [];
    const samePlatformGapMs = MIN_PLATFORM_GAP_HOURS * 60 * 60 * 1000;
    const crossPlatformGapMs = MIN_CROSS_PLATFORM_GAP_HOURS * 60 * 60 * 1000;

    await db.transaction(async (tx) => {
      for (const p of proposalInputs) {
        const scheduledAt = new Date(p.scheduledAt);

        const nearbyEntries = await tx
          .select()
          .from(calendarEntriesTable)
          .where(
            and(
              gte(calendarEntriesTable.scheduledAt, new Date(scheduledAt.getTime() - samePlatformGapMs)),
              lte(calendarEntriesTable.scheduledAt, new Date(scheduledAt.getTime() + samePlatformGapMs)),
            ),
          );

        const hasConflictNow = nearbyEntries.some((e) => {
          const diff = Math.abs(e.scheduledAt.getTime() - scheduledAt.getTime());
          if (e.platform === p.platform) return diff < samePlatformGapMs;
          return diff < crossPlatformGapMs;
        });

        if (hasConflictNow) {
          conflicts.push(`${p.platform} variant at ${p.scheduledAt} conflicts with existing entry`);
          continue;
        }

        const proposalKey = `${p.creativeId}:${p.variantId}`;
        const matchedProposal = proposalMap.get(proposalKey);

        const [entry] = await tx
          .insert(calendarEntriesTable)
          .values({
            creativeId: p.creativeId,
            variantId: p.variantId,
            platform: p.platform,
            scheduledAt,
            scheduleMethod: "smart_schedule",
            proposalId: matchedProposal?.id || null,
          })
          .returning();

        created.push(entry);
        creativeIdSet.add(p.creativeId);

        if (matchedProposal) {
          await tx
            .update(smartScheduleProposalsTable)
            .set({
              status: "confirmed",
              confirmedAt: new Date(),
              finalTime: scheduledAt,
              calendarEntryId: entry.id,
            })
            .where(eq(smartScheduleProposalsTable.id, matchedProposal.id));
        }
      }

      for (const creativeId of creativeIdSet) {
        await tx
          .update(creativesTable)
          .set({ status: "scheduled", updatedAt: new Date() })
          .where(eq(creativesTable.id, creativeId));
        creativesScheduled.push(creativeId);
      }
    });

    res.status(201).json({
      created,
      creativesScheduled,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    });
  },
);

const ConfirmByIdsBody = z.object({
  proposalIds: z.array(z.string().min(1)).min(1),
  timeOverrides: z
    .record(z.string(), z.string().refine((val) => !isNaN(new Date(val).getTime()), {
      message: "Invalid datetime string",
    }))
    .optional()
    .default({}),
});

router.post(
  "/smart-schedule/confirm-by-ids",
  validateRequest({ body: ConfirmByIdsBody }),
  async (req, res): Promise<void> => {
    const { proposalIds, timeOverrides } = req.body;

    const createdEntries: (typeof calendarEntriesTable.$inferSelect)[] = [];
    const conflicts: string[] = [];

    for (const proposalId of proposalIds) {
      const proposal = await db
        .select()
        .from(smartScheduleProposalsTable)
        .where(eq(smartScheduleProposalsTable.id, proposalId))
        .then((r) => r[0]);

      if (!proposal || proposal.status !== "pending") continue;

      const overriddenTime = timeOverrides[proposalId];
      const scheduledAt = overriddenTime
        ? new Date(overriddenTime)
        : proposal.proposedAt;

      const samePlatformGapMs = MIN_PLATFORM_GAP_HOURS * 60 * 60 * 1000;
      const crossPlatformGapMs = MIN_CROSS_PLATFORM_GAP_HOURS * 60 * 60 * 1000;
      const nearbyEntries = await db
        .select()
        .from(calendarEntriesTable)
        .where(
          and(
            gte(calendarEntriesTable.scheduledAt, new Date(scheduledAt.getTime() - samePlatformGapMs)),
            lte(calendarEntriesTable.scheduledAt, new Date(scheduledAt.getTime() + samePlatformGapMs)),
          ),
        );

      const hasConflictNow = nearbyEntries.some((e) => {
        const diff = Math.abs(e.scheduledAt.getTime() - scheduledAt.getTime());
        if (e.platform === proposal.platform) return diff < samePlatformGapMs;
        return diff < crossPlatformGapMs;
      });

      if (hasConflictNow) {
        conflicts.push(`Proposal ${proposalId} conflicts with existing entry`);
        continue;
      }

      const isModified = !!overriddenTime;
      const method = isModified ? "smart_schedule_modified" : "smart_schedule";

      const [entry] = await db
        .insert(calendarEntriesTable)
        .values({
          creativeId: proposal.creativeId,
          variantId: proposal.variantId,
          platform: proposal.platform,
          scheduledAt,
          scheduleMethod: method,
          smartScheduleRationale: proposal.rationale,
          proposalId: proposal.id,
        })
        .returning();

      await db
        .update(smartScheduleProposalsTable)
        .set({
          status: "confirmed",
          confirmedAt: new Date(),
          calendarEntryId: entry.id,
        })
        .where(eq(smartScheduleProposalsTable.id, proposalId));

      createdEntries.push(entry);
    }

    if (createdEntries.length > 0) {
      const creativeIds = [...new Set(createdEntries.map((e) => e.creativeId))];
      for (const cid of creativeIds) {
        await db
          .update(creativesTable)
          .set({ status: "scheduled", updatedAt: new Date() })
          .where(eq(creativesTable.id, cid));
      }
    }

    res.json({
      entries: createdEntries,
      count: createdEntries.length,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    });
  },
);

export default router;

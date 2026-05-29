import { str } from "../lib/http-params.js";
import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, brandsTable, brandScheduleProfilesTable, costLogsTable } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { AI_MODELS } from "../lib/ai-config.js";
import { extractJSON } from "../lib/extract-json.js";
import { generationLimiter } from "../lib/rate-limit.js";

const router: IRouter = Router();

interface SlotData {
  day: number;
  hour: number;
  score: number;
  status: "preferred" | "acceptable" | "blocked";
}

interface AIScheduleResponse {
  slots: SlotData[];
}

const PLATFORM_BASELINES: Record<string, string> = {
  twitter: "Peak engagement: weekdays 8-10am and 12-1pm. Tweets during lunch breaks and early morning commutes perform best. Weekends are lower but Sunday evenings see increased activity.",
  instagram_feed: "Peak engagement: weekdays 11am-1pm and 7-9pm. Feed posts get steady engagement during lunch hours. Weekends, especially Sunday, see high engagement.",
  instagram_story: "Peak engagement: weekdays 7-9am and 8-10pm. Stories are consumed during commute and evening wind-down. Weekend mornings are also strong.",
  linkedin: "Peak engagement: Tuesday-Thursday 8-10am and 12pm. Professional content performs best mid-week during business hours. Weekends have minimal engagement.",
  tiktok: "Peak engagement: weekdays 7-9am, 12-3pm, and 7-11pm. TikTok users are most active during breaks and evening hours. Weekends see consistent engagement throughout the day.",
};

router.get("/brands/:brandId/schedule-profile", async (req, res): Promise<void> => {
  const brandId = str(req.params.brandId);

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const profiles = await db
    .select()
    .from(brandScheduleProfilesTable)
    .where(eq(brandScheduleProfilesTable.brandId, brandId))
    .orderBy(brandScheduleProfilesTable.platform, brandScheduleProfilesTable.dayOfWeek, brandScheduleProfilesTable.hour);

  const grouped: Record<string, SlotData[]> = {};
  for (const p of profiles) {
    if (!grouped[p.platform]) grouped[p.platform] = [];
    grouped[p.platform].push({
      day: p.dayOfWeek,
      hour: p.hour,
      score: p.score,
      status: p.status as "preferred" | "acceptable" | "blocked",
    });
  }

  res.json({ brandId, timezone: brand.timezone, profiles: grouped });
});

const VALID_STATUSES = ["preferred", "acceptable", "blocked"];
const VALID_PLATFORMS = ["twitter", "instagram_feed", "instagram_story", "linkedin", "tiktok"];
const MAX_SLOTS_PER_REQUEST = 1200;

function validateSlot(slot: { platform?: string; day?: number; hour?: number; score?: number; status?: string }): string | null {
  if (!slot.platform || !VALID_PLATFORMS.includes(slot.platform)) return `Invalid platform: ${slot.platform}`;
  if (typeof slot.day !== "number" || slot.day < 0 || slot.day > 6) return `Invalid day: ${slot.day}`;
  if (typeof slot.hour !== "number" || slot.hour < 0 || slot.hour > 23) return `Invalid hour: ${slot.hour}`;
  if (typeof slot.score !== "number" || slot.score < 0 || slot.score > 1) return `Invalid score: ${slot.score}`;
  if (!slot.status || !VALID_STATUSES.includes(slot.status)) return `Invalid status: ${slot.status}`;
  return null;
}

router.put("/brands/:brandId/schedule-profile", async (req, res): Promise<void> => {
  const brandId = str(req.params.brandId);
  const { slots } = req.body as { slots: Array<{ platform: string; day: number; hour: number; score: number; status: string }> };

  if (!Array.isArray(slots)) {
    res.status(400).json({ error: "slots must be an array" });
    return;
  }

  if (slots.length > MAX_SLOTS_PER_REQUEST) {
    res.status(400).json({ error: `Too many slots (max ${MAX_SLOTS_PER_REQUEST})` });
    return;
  }

  for (const slot of slots) {
    const err = validateSlot(slot);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  for (const slot of slots) {
    const existing = await db
      .select()
      .from(brandScheduleProfilesTable)
      .where(
        and(
          eq(brandScheduleProfilesTable.brandId, brandId),
          eq(brandScheduleProfilesTable.platform, slot.platform),
          eq(brandScheduleProfilesTable.dayOfWeek, slot.day),
          eq(brandScheduleProfilesTable.hour, slot.hour),
        )
      );

    if (existing.length > 0) {
      await db
        .update(brandScheduleProfilesTable)
        .set({ score: slot.score, status: slot.status, updatedAt: new Date() })
        .where(eq(brandScheduleProfilesTable.id, existing[0].id));
    } else {
      await db.insert(brandScheduleProfilesTable).values({
        brandId,
        platform: slot.platform,
        dayOfWeek: slot.day,
        hour: slot.hour,
        score: slot.score,
        status: slot.status,
      });
    }
  }

  res.json({ message: "Schedule profile updated", count: slots.length });
});

router.post("/brands/:brandId/schedule-profile/generate", generationLimiter, async (req, res): Promise<void> => {
  const brandId = str(req.params.brandId);
  const { platform } = req.body as { platform?: string };

  const [brand] = await db.select().from(brandsTable).where(eq(brandsTable.id, brandId));
  if (!brand) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  if (platform && !VALID_PLATFORMS.includes(platform)) {
    res.status(400).json({ error: `Invalid platform: ${platform}` });
    return;
  }

  const platforms = platform ? [platform] : VALID_PLATFORMS;
  const allSlots: Array<{ platform: string; slots: SlotData[] }> = [];

  for (const plat of platforms) {
    const baseline = PLATFORM_BASELINES[plat] || "General social media best practices apply.";

    const prompt = `You are a social media scheduling expert. Generate an optimal weekly posting schedule heat map for the platform "${plat}".

Brand: ${brand.name}
Voice/Vertical: ${brand.voiceDescription || "General content"}
Timezone: ${brand.timezone}
Platform baseline data: ${baseline}

Generate a 7x24 grid (7 days × 24 hours = 168 slots) representing the best times to post.
Days are 0=Sunday through 6=Saturday.
Hours are 0-23 in 24-hour format.

For each slot, assign:
- score: 0.0 to 1.0 (higher = better time to post)
- status: "preferred" (score >= 0.7), "acceptable" (score 0.3-0.69), or "blocked" (score < 0.3)

Focus on realistic engagement windows. Most hours should be "blocked" (low engagement). Only a few peak windows should be "preferred".

Return ONLY valid JSON:
{
  "slots": [
    { "day": 0, "hour": 0, "score": 0.1, "status": "blocked" },
    ...all 168 slots...
  ]
}`;

    const response = await anthropic.messages.create({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 8192,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((b: { type: string }) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(500).json({ error: `No response from AI for platform ${plat}` });
      return;
    }

    const parsed = extractJSON<AIScheduleResponse>(textBlock.text);

    if (!parsed.slots || !Array.isArray(parsed.slots)) {
      res.status(500).json({ error: `Invalid AI response structure for platform ${plat}` });
      return;
    }

    const validatedSlots = parsed.slots.filter(s =>
      typeof s.day === "number" && s.day >= 0 && s.day <= 6 &&
      typeof s.hour === "number" && s.hour >= 0 && s.hour <= 23 &&
      typeof s.score === "number" && s.score >= 0 && s.score <= 1 &&
      VALID_STATUSES.includes(s.status)
    );

    const slotMap = new Map<string, SlotData>();
    for (const s of validatedSlots) {
      const key = `${s.day}-${s.hour}`;
      if (!slotMap.has(key)) {
        slotMap.set(key, s);
      }
    }

    for (let day = 0; day <= 6; day++) {
      for (let hour = 0; hour <= 23; hour++) {
        const key = `${day}-${hour}`;
        if (!slotMap.has(key)) {
          slotMap.set(key, { day, hour, score: 0.1, status: "blocked" });
        }
      }
    }

    const uniqueSlots = Array.from(slotMap.values());

    await db
      .delete(brandScheduleProfilesTable)
      .where(
        and(
          eq(brandScheduleProfilesTable.brandId, brandId),
          eq(brandScheduleProfilesTable.platform, plat),
        )
      );

    const rows = uniqueSlots.map(slot => ({
      brandId,
      platform: plat,
      dayOfWeek: slot.day,
      hour: slot.hour,
      score: Math.max(0, Math.min(1, slot.score)),
      status: slot.status,
    }));

    if (rows.length > 0) {
      await db.insert(brandScheduleProfilesTable).values(rows);
    }

    allSlots.push({ platform: plat, slots: uniqueSlots });
  }

  await db.insert(costLogsTable).values({
    service: "anthropic",
    operation: "schedule_profile_generation",
    model: AI_MODELS.CLAUDE_SONNET,
    costUsd: 0.01 * platforms.length,
  });

  res.json({ brandId, generated: allSlots });
});

export default router;

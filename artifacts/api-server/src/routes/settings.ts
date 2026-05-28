import { Router, type IRouter } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { db, appSettingsTable, costLogsTable } from "@workspace/db";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";

const ALLOWED_SETTING_KEYS = [
  "dailyCostThreshold",
  "monthlyCostThreshold",
  "costAlertEmail",
  "defaultTimezone",
  "defaultPublishLeadMinutes",
] as const;
type AllowedKey = typeof ALLOWED_SETTING_KEYS[number];
const ALLOWED_SET = new Set<string>(ALLOWED_SETTING_KEYS);

const UpdateSettingsBody = z.object(
  Object.fromEntries(ALLOWED_SETTING_KEYS.map(k => [k, z.string().max(500).optional()])) as Record<AllowedKey, z.ZodOptional<z.ZodString>>,
).strict();

const router: IRouter = Router();

router.get("/settings", async (_req, res): Promise<void> => {
  const rows = await db.select().from(appSettingsTable).where(inArray(appSettingsTable.key, [...ALLOWED_SETTING_KEYS]));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (ALLOWED_SET.has(row.key)) settings[row.key] = row.value;
  }
  res.json(settings);
});

router.put("/settings", requireRole("admin"), validateRequest({ body: UpdateSettingsBody }), async (req, res): Promise<void> => {
  const updates = req.body as Record<string, unknown>;

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== "string") continue;
    if (!ALLOWED_SET.has(key)) continue;
    await db
      .insert(appSettingsTable)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettingsTable.key,
        set: { value, updatedAt: new Date() },
      });
  }

  const rows = await db.select().from(appSettingsTable).where(inArray(appSettingsTable.key, [...ALLOWED_SETTING_KEYS]));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (ALLOWED_SET.has(row.key)) settings[row.key] = row.value;
  }
  res.json(settings);
});

router.get("/settings/daily-budget-status", async (_req, res): Promise<void> => {
  const [thresholdRow] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, "dailyCostThreshold"));

  const threshold = thresholdRow ? parseFloat(thresholdRow.value) : null;

  if (threshold === null || isNaN(threshold)) {
    res.json({ threshold: null, todaySpend: 0, remaining: null, overBudget: false });
    return;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [result] = await db
    .select({
      totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    })
    .from(costLogsTable)
    .where(sql`${costLogsTable.createdAt} >= ${todayStart}`);

  const todaySpend = Number(result?.totalCost || 0);
  const remaining = threshold - todaySpend;

  res.json({
    threshold,
    todaySpend,
    remaining,
    overBudget: todaySpend >= threshold,
    nearLimit: todaySpend >= threshold * 0.8,
  });
});

export default router;

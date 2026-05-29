import { Router, type IRouter } from "express";
import { eq, desc, gte, lte, and, sql } from "drizzle-orm";
import { db, costLogsTable, costLogMonthlySummaryTable } from "@workspace/db";

const router: IRouter = Router();

function parseValidDate(value: unknown): Date | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

router.get("/cost-logs", async (req, res): Promise<void> => {
  const { startDate, endDate, service, operation, limit: limitStr } = req.query;

  if (startDate && !parseValidDate(startDate)) {
    res.status(400).json({ error: "Invalid startDate format" });
    return;
  }
  if (endDate && !parseValidDate(endDate)) {
    res.status(400).json({ error: "Invalid endDate format" });
    return;
  }

  const conditions = [];
  const parsedStart = parseValidDate(startDate);
  const parsedEnd = parseValidDate(endDate);
  if (parsedStart) {
    conditions.push(gte(costLogsTable.createdAt, parsedStart));
  }
  if (parsedEnd) {
    conditions.push(lte(costLogsTable.createdAt, parsedEnd));
  }
  if (service) {
    conditions.push(eq(costLogsTable.service, service as string));
  }
  if (operation) {
    conditions.push(eq(costLogsTable.operation, operation as string));
  }

  const rawLimit = parseInt(limitStr as string);
  const queryLimit = Math.min(Math.max(isNaN(rawLimit) ? 200 : rawLimit, 1), 1000);

  let query = db.select().from(costLogsTable);
  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const results = await query.orderBy(desc(costLogsTable.createdAt)).limit(queryLimit);
  res.json(results);
});

router.get("/cost-logs/summary", async (req, res): Promise<void> => {
  const { startDate, endDate } = req.query;

  if (startDate && !parseValidDate(startDate)) {
    res.status(400).json({ error: "Invalid startDate format" });
    return;
  }
  if (endDate && !parseValidDate(endDate)) {
    res.status(400).json({ error: "Invalid endDate format" });
    return;
  }

  const conditions = [];
  const parsedStart = parseValidDate(startDate);
  const parsedEnd = parseValidDate(endDate);
  if (parsedStart) {
    conditions.push(gte(costLogsTable.createdAt, parsedStart));
  }
  if (parsedEnd) {
    conditions.push(lte(costLogsTable.createdAt, parsedEnd));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Rows older than the retention window are rolled up into
  // cost_log_monthly_summary (see scripts/src/archive-cost-logs.ts) and removed
  // from cost_logs. Archival is whole-month aligned, so the two tables never
  // cover the same month and can be combined without double counting. We read
  // both here so totals stay correct over the full lifetime, not just the
  // retained window. The summary table is filtered by its `month` column so a
  // date-bounded request only includes archived months within range.
  const summaryConditions = [];
  if (parsedStart) {
    summaryConditions.push(gte(costLogMonthlySummaryTable.month, parsedStart));
  }
  if (parsedEnd) {
    summaryConditions.push(lte(costLogMonthlySummaryTable.month, parsedEnd));
  }
  const summaryWhereClause = summaryConditions.length > 0 ? and(...summaryConditions) : undefined;

  const totalResult = await db.select({
    totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    totalEntries: sql<number>`COUNT(*)`,
  }).from(costLogsTable).where(whereClause);

  const byService = await db.select({
    service: costLogsTable.service,
    totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(costLogsTable).where(whereClause).groupBy(costLogsTable.service);

  const byOperation = await db.select({
    operation: costLogsTable.operation,
    service: costLogsTable.service,
    totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(costLogsTable).where(whereClause).groupBy(costLogsTable.operation, costLogsTable.service);

  const dailySpend = await db.select({
    date: sql<string>`DATE(${costLogsTable.createdAt})`,
    totalCost: sql<number>`COALESCE(SUM(${costLogsTable.costUsd}), 0)`,
    count: sql<number>`COUNT(*)`,
  }).from(costLogsTable).where(whereClause)
    .groupBy(sql`DATE(${costLogsTable.createdAt})`)
    .orderBy(sql`DATE(${costLogsTable.createdAt})`);

  // Archived (rolled-up) aggregates from the monthly summary table.
  const archivedTotal = await db.select({
    totalCost: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.totalCostUsd}), 0)`,
    totalEntries: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.entryCount}), 0)`,
  }).from(costLogMonthlySummaryTable).where(summaryWhereClause);

  const archivedByService = await db.select({
    service: costLogMonthlySummaryTable.service,
    totalCost: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.totalCostUsd}), 0)`,
    count: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.entryCount}), 0)`,
  }).from(costLogMonthlySummaryTable).where(summaryWhereClause).groupBy(costLogMonthlySummaryTable.service);

  const archivedByOperation = await db.select({
    operation: costLogMonthlySummaryTable.operation,
    service: costLogMonthlySummaryTable.service,
    totalCost: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.totalCostUsd}), 0)`,
    count: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.entryCount}), 0)`,
  }).from(costLogMonthlySummaryTable).where(summaryWhereClause)
    .groupBy(costLogMonthlySummaryTable.operation, costLogMonthlySummaryTable.service);

  // Archived rows only have monthly granularity, so each archived month becomes
  // a single daily-spend bucket dated to the first day of that month.
  const archivedMonthlySpend = await db.select({
    date: sql<string>`TO_CHAR(${costLogMonthlySummaryTable.month}, 'YYYY-MM-DD')`,
    totalCost: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.totalCostUsd}), 0)`,
    count: sql<number>`COALESCE(SUM(${costLogMonthlySummaryTable.entryCount}), 0)`,
  }).from(costLogMonthlySummaryTable).where(summaryWhereClause)
    .groupBy(costLogMonthlySummaryTable.month)
    .orderBy(costLogMonthlySummaryTable.month);

  // Merge live + archived aggregates keyed by their grouping columns.
  const serviceMap = new Map<string, { service: string; totalCost: number; count: number }>();
  for (const s of byService) {
    serviceMap.set(s.service, { service: s.service, totalCost: Number(s.totalCost), count: Number(s.count) });
  }
  for (const s of archivedByService) {
    const existing = serviceMap.get(s.service);
    if (existing) {
      existing.totalCost += Number(s.totalCost);
      existing.count += Number(s.count);
    } else {
      serviceMap.set(s.service, { service: s.service, totalCost: Number(s.totalCost), count: Number(s.count) });
    }
  }

  const operationMap = new Map<string, { operation: string; service: string; totalCost: number; count: number }>();
  for (const o of byOperation) {
    operationMap.set(`${o.service}::${o.operation}`, { operation: o.operation, service: o.service, totalCost: Number(o.totalCost), count: Number(o.count) });
  }
  for (const o of archivedByOperation) {
    const key = `${o.service}::${o.operation}`;
    const existing = operationMap.get(key);
    if (existing) {
      existing.totalCost += Number(o.totalCost);
      existing.count += Number(o.count);
    } else {
      operationMap.set(key, { operation: o.operation, service: o.service, totalCost: Number(o.totalCost), count: Number(o.count) });
    }
  }

  const dailyMap = new Map<string, { date: string; totalCost: number; count: number }>();
  for (const d of dailySpend) {
    dailyMap.set(d.date, { date: d.date, totalCost: Number(d.totalCost), count: Number(d.count) });
  }
  for (const d of archivedMonthlySpend) {
    const existing = dailyMap.get(d.date);
    if (existing) {
      existing.totalCost += Number(d.totalCost);
      existing.count += Number(d.count);
    } else {
      dailyMap.set(d.date, { date: d.date, totalCost: Number(d.totalCost), count: Number(d.count) });
    }
  }

  res.json({
    totalCost: Number(totalResult[0]?.totalCost || 0) + Number(archivedTotal[0]?.totalCost || 0),
    totalEntries: Number(totalResult[0]?.totalEntries || 0) + Number(archivedTotal[0]?.totalEntries || 0),
    byService: Array.from(serviceMap.values()),
    byOperation: Array.from(operationMap.values()),
    dailySpend: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  });
});

export default router;

import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, hashtagSetsTable } from "@workspace/db";
import { requireDestructive } from "../middleware/auth.js";
import {
  GetHashtagSetsQueryParams,
  CreateHashtagSetBody,
  UpdateHashtagSetParams,
  GetHashtagSetsResponse,
  UpdateHashtagSetBody,
  UpdateHashtagSetResponse,
  DeleteHashtagSetParams,
  DeleteHashtagSetResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/hashtag-sets", async (req, res): Promise<void> => {
  const query = GetHashtagSetsQueryParams.safeParse(req.query);
  const conditions = [];

  if (query.success && query.data.brandId) {
    conditions.push(eq(hashtagSetsTable.brandId, query.data.brandId));
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const baseCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hashtagSetsTable)
    .where(baseCondition);
  const total = countResult?.count ?? 0;

  const results = baseCondition
    ? await db.select().from(hashtagSetsTable).where(baseCondition).orderBy(hashtagSetsTable.createdAt).limit(limit).offset(offset)
    : await db.select().from(hashtagSetsTable).orderBy(hashtagSetsTable.createdAt).limit(limit).offset(offset);

  res.json({ data: results, total, limit, offset });
});

router.post("/hashtag-sets", async (req, res): Promise<void> => {
  const parsed = CreateHashtagSetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [set] = await db.insert(hashtagSetsTable).values(parsed.data).returning();
  res.status(201).json(UpdateHashtagSetResponse.parse(set));
});

router.put("/hashtag-sets/:id", async (req, res): Promise<void> => {
  const params = UpdateHashtagSetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateHashtagSetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [set] = await db
    .update(hashtagSetsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(hashtagSetsTable.id, params.data.id))
    .returning();

  if (!set) {
    res.status(404).json({ error: "Hashtag set not found" });
    return;
  }

  res.json(UpdateHashtagSetResponse.parse(set));
});

router.delete("/hashtag-sets/:id", requireDestructive, async (req, res): Promise<void> => {
  const params = DeleteHashtagSetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [set] = await db.delete(hashtagSetsTable).where(eq(hashtagSetsTable.id, params.data.id)).returning();
  if (!set) {
    res.status(404).json({ error: "Hashtag set not found" });
    return;
  }

  res.json(DeleteHashtagSetResponse.parse({ message: "Hashtag set deleted" }));
});

export default router;

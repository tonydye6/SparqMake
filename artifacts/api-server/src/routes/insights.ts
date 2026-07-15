import { Router, type IRouter, type Request, type Response } from "express";
import {
  getIntentInsights,
  getInsightsByIntent,
  syncPerformanceSignals,
} from "../services/performance-insights.js";

const router: IRouter = Router();

// GET /insights/recommendations?brandId&intent — data-backed recommendations
// for the studio (post-intent-confirmation panel) and fan-out (platform
// emphasis + suggested times). Always returns honest confidence + reasoning;
// low/no data degrades to explicit "not enough data yet" messaging.
router.get("/insights/recommendations", async (req: Request, res: Response): Promise<void> => {
  const { brandId, intent } = req.query;
  const insights = await getIntentInsights({
    brandId: typeof brandId === "string" && brandId ? brandId : undefined,
    intent: typeof intent === "string" && intent ? intent : null,
  });
  // Refresh the mirrored performance signals in the background — never blocks
  // or fails the recommendation response.
  void syncPerformanceSignals(typeof brandId === "string" && brandId ? brandId : undefined);
  res.json(insights);
});

// GET /insights/by-intent?brandId — per-intent performance breakdown for the
// dashboard's intent dimension.
router.get("/insights/by-intent", async (req: Request, res: Response): Promise<void> => {
  const { brandId } = req.query;
  const insights = await getInsightsByIntent(
    typeof brandId === "string" && brandId ? brandId : undefined,
  );
  res.json({ data: insights });
});

export default router;

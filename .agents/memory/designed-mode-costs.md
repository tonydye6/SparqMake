---
name: Designed-graphic cost model
description: How designed render_mode changes billing across generate.ts entry points
---

Designed mode (creatives.render_mode='designed') does NOT bill one AI image per platform. Unit cost = 1 cutout image + 2 Gemini text calls (design spec + vision QA); SSE /generate pays prepare once (captions + spec + cutout) and renders per platform with only a QA text call each.

**Why:** budget reservation, 429 gating, and persisted cost_logs rows all read from the same daily-spend sum; if any entry point (SSE /generate, variant regen/vary, board takes, persona compare) uses the scene-mode estimate for designed creatives, budgets over- or under-enforce silently (architect flagged this exact drift on first integration).

**How to apply:** any new generation entry point or change to the designed pipeline's billable calls must update `estimateDesignedUnitCost()` and every reservation + cost-log site in lockstep, branching on `campaign.renderMode === "designed"`.

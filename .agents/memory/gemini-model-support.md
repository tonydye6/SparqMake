---
name: Gemini model support & direct-API access
description: Which Gemini models work via Replit proxy vs direct Google API; how the pipeline selects credentials and generates video
---
- Replit AI proxy rejects gemini-3.x models (gemini-3-pro-image, gemini-3.5-flash, gemini-omni-flash-preview) with UNSUPPORTED_MODEL; only gemini-2.5-flash works there (but gemini-2.5-flash returns 404 "no longer available" on direct API — proxy-only).
- The Gemini integration lib prefers `GEMINI_API_KEY` (direct Google API, no baseUrl), falling back to Replit proxy env vars when absent. `GEMINI_API_KEY` IS set in this environment.
- **Why:** user chose their own key to access Nano Banana Pro / Gemini 3.5 / Omni Flash video after the proxy rejected them.
- **gemini-3-pro-image (Nano Banana Pro):** direct API OK via both generateContent AND interactions.create(); multi-turn editing confirmed (pass `interaction_id` as `previous_interaction_id`). Use interactions.create() for Co-pilot Studio.
- **gemini-omni-flash-preview:** MUST use interactions.create() with `response_format:{type:"video"}`; generateContent returns 400 "This model only supports Interactions API." Returns base64 `output_video.data`, status:"completed".
- **gemini-3.5-flash:** direct API OK via generateContent; use for art direction and QA review.
- Co-pilot model pins live in `COPILOT_MODELS` in `artifacts/api-server/src/lib/ai-config.ts`; verification report at `artifacts/api-server/docs/copilot-model-verification.md`.

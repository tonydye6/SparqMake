---
name: Gemini model support & direct-API access
description: Which Gemini models work via Replit proxy vs direct Google API; how the pipeline selects credentials and generates video
---
- Replit AI proxy rejects preview-dated and gemini-3.x models (gemini-3-pro-image, gemini-3.5-flash, gemini-omni-flash-preview) with UNSUPPORTED_MODEL; only stable gemini-2.5-flash/pro/flash-image work there. Proxy also rate-limits bulk vision runs — chunk large backfills.
- The Gemini integration lib now prefers a user-supplied `GEMINI_API_KEY` (direct Google API, no baseUrl), falling back to the Replit proxy env vars when absent. Direct API unlocks the gemini-3.x models.
- **Why:** user chose their own key to access Nano Banana Pro / Gemini 3.5 / Omni Flash video after the proxy rejected them.
- Video uses `ai.interactions.create` (Interactions API, requires @google/genai ≥2.0) with `response_format: {type:"video", aspect_ratio}` and returns base64 `output_video.data` — no Veo-style operation polling or URI fetch.

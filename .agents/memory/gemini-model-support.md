---
name: Gemini proxy supported models
description: Which Gemini model names the Replit AI proxy accepts; preview-dated names are rejected.
---
The Replit-managed Gemini proxy rejects preview-dated model names (e.g. `gemini-2.5-flash-preview-05-20`) with UNSUPPORTED_MODEL. Only stable names work: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-image`.
**Why:** the default text model in `ai-config.ts` was a preview name and every vision/text call failed at runtime while typecheck stayed green.
**How to apply:** when adding AI calls or debugging UNSUPPORTED_MODEL, use stable model names; the proxy also rate-limits bulk vision runs (RATELIMIT_EXCEEDED) — chunk large backfills with pauses.

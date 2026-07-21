# Co-pilot Studio — Gemini Model Verification Report

**Date:** 2026-07-21  
**Task:** Co-pilot Studio Task 0 — Verify new Gemini models & add env-overridable pins

---

## Summary

All three target Gemini models require **direct API access** (`GEMINI_API_KEY`).  
None of the three resolve through the Replit AI proxy (`AI_INTEGRATIONS_GEMINI_BASE_URL`).  
`GEMINI_API_KEY` is already set in this environment.

---

## Model-by-Model Results

### 1. IMAGE render + edit — `gemini-3-pro-image` (Nano Banana Pro)

| Access path | Result |
|---|---|
| Replit proxy (`AI_INTEGRATIONS_GEMINI_BASE_URL`) | ❌ `UNSUPPORTED_MODEL` |
| Direct API — `generateContent` | ✅ OK |
| Direct API — `interactions.create()` (create) | ✅ OK — returns `output_image` + `interaction_id` |
| Direct API — `interactions.create()` (follow-up with `previous_interaction_id`) | ✅ OK — multi-turn edit confirmed |

**Recommended path:** Direct API via `interactions.create()`.  
The Interactions API is the correct call surface for this model; `generateContent` also works but the Interactions pattern supports multi-turn semantic edits required by Co-pilot Studio.

**Note:** `gemini-3-pro-image-preview` (with `-preview` suffix) resolves on direct API but 404s on the proxy. The canonical unprefixed id `gemini-3-pro-image` is the right pin.

---

### 2. VIDEO generate + edit — `gemini-omni-flash-preview` (Gemini Omni Flash)

| Access path | Result |
|---|---|
| Replit proxy (`AI_INTEGRATIONS_GEMINI_BASE_URL`) | ❌ `UNSUPPORTED_MODEL` |
| Direct API — `generateContent` | ❌ `400 INVALID_ARGUMENT` — "This model only supports Interactions API." |
| Direct API — `interactions.create()` with `response_format:{type:"video"}` | ✅ OK — returns `output_video` (base64), `status:"completed"` |

**Recommended path:** Direct API via `interactions.create()` **only**.  
`generateContent` is explicitly rejected by the API. The Interactions pattern is mandatory for this model.

---

### 3. ART DIRECTION + QUALITY REVIEW — `gemini-3.5-flash`

| Access path | Result |
|---|---|
| Replit proxy (`AI_INTEGRATIONS_GEMINI_BASE_URL`) | ❌ `UNSUPPORTED_MODEL` |
| Direct API — `generateContent` | ✅ OK |

**Recommended path:** Direct API via `generateContent`.

**Note:** `gemini-2.5-flash` (the proxy-supported text model) returns `404 — "no longer available to new users"` on direct API, so it cannot serve as a substitute. The existing `GEMINI_FLASH_TEXT` pin in `AI_MODELS` already defaults to `gemini-3.5-flash` which resolves correctly on direct API.

---

### 4. Captions/concepts — Claude pin

No change. Out of scope for this task.

---

## Proxy — Supported Model Reference

For completeness, the one Co-pilot-adjacent model that **does** resolve through the proxy:

| Model | Proxy | Direct API |
|---|---|---|
| `gemini-2.5-flash` | ✅ OK | ❌ 404 deprecated |

---

## Env-Overridable Pins Added

`artifacts/api-server/src/lib/ai-config.ts` exports `COPILOT_MODELS`:

```typescript
export const COPILOT_MODELS = {
  NANO_BANANA_MODEL: process.env.NANO_BANANA_MODEL || "gemini-3-pro-image",
  OMNI_VIDEO_MODEL:  process.env.OMNI_VIDEO_MODEL  || "gemini-omni-flash-preview",
  ART_DIRECTION_MODEL: process.env.ART_DIRECTION_MODEL || "gemini-3.5-flash",
  QA_MODEL:          process.env.QA_MODEL          || "gemini-3.5-flash",
} as const;
```

No existing `AI_MODELS` entries or call sites were modified.

---

## Key Constraints for Phase 1 Implementation

- All three Gemini targets need `GEMINI_API_KEY` (already configured in this environment).
- `NANO_BANANA_MODEL` and `OMNI_VIDEO_MODEL` **must** be called via `directClient.interactions.create()`, not `ai.models.generateContent()`.
- Multi-turn image editing is confirmed working: pass the `interaction_id` from the first call as `previous_interaction_id` in subsequent calls.
- `ART_DIRECTION_MODEL` / `QA_MODEL` use standard `generateContent`.

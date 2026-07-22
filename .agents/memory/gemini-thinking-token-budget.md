---
name: Gemini thinking models eat maxOutputTokens
description: Truncated/short "non-JSON" output from gemini-3.5-flash is usually the thinking budget consuming maxOutputTokens, not the model ignoring responseMimeType.
---
# Gemini thinking token budget

gemini-3.5-flash (and other thinking-tier Gemini models) count reasoning ("thoughts") tokens against `maxOutputTokens`. A tiny prompt already burned ~700 thought tokens; with a large context the visible text gets truncated mid-JSON while `finishReason` still reads STOP-like/normal, so it looks like the model "returned 110 chars of non-JSON."

**Why:** The creative-director step returned short truncated JSON on every live run with a 1024 budget and 40 catalog lines, silently killing asset selection via the prose fallback.

**How to apply:** For any structured-output generateContent call on a thinking model, set `maxOutputTokens` generously (8192), pass a `responseSchema` (not just `responseMimeType`), check `usageMetadata.thoughtsTokenCount` when output looks truncated, and keep a deterministic temperature-0 retry before any prose fallback.

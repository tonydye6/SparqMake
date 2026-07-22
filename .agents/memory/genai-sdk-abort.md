---
name: genai SDK real abort
description: How to truly cancel in-flight @google/genai interactions requests with an AbortSignal
---

Racing an abortPromise against `ai.interactions.create(...)` only abandons the promise — the underlying HTTP request keeps running and the generation still bills.

**Rule:** pass the signal into the SDK request itself: `ai.interactions.create(body, { fetchOptions: { signal } })` (second options arg, `GoogleGenAIRequestOptions`).

**Why:** the live capability probe (docs/INTERACTIONS_CAPABILITIES.md) confirmed the request rejects ~256ms after abort when the signal is wired through fetchOptions; without it the model runs to completion (60–90s image, up to 300s video) at full cost.

**How to apply:** any new SDK call that should be cancellable on client disconnect must forward the route-level AbortController signal via fetchOptions. Keep a fallback abortPromise race only for a clearer error message. Verify manually: start a turn via curl (needs `Origin` header), kill after a few seconds, expect turn status `cancelled` and "Turn cancelled by abort signal" in logs.

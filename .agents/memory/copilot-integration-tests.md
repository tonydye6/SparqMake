---
name: Co-pilot Studio integration tests
description: How api-server integration tests run against the real dev Postgres with mocked model boundaries
---

Co-pilot Studio integration tests (`*.integration.test.ts` in api-server) run against the **real** dev Postgres (DATABASE_URL) while mocking only model/storage boundaries (anthropic, gemini, interactions-client, storage, compositing, focal-point).

**Why:** the fully-mocked chainable-db pattern in the older unit tests silently drifts from real Drizzle/SQL behavior (branchSession fixtures broke when new logic started filtering on `seq`/`action` the mocks never set).

**How to apply:**
- Seed unique rows per run (user → brand → creative → session), clean up in `afterAll` by deleting cost_logs by creativeId first (FK is SET NULL), then the brand (cascades), then the user, then `pool.end()`.
- Keep the real `PLATFORM_CONFIGS` via `vi.mock` + `importOriginal` when asserting per-platform behavior.
- Route-level tests mount the router on an ephemeral express server with a middleware injecting `req.user = { role: "editor" }` (dev-bypass alone doesn't set req.user for `requireEditorForWrites`).
- When session-service gains a new import from `../lib/ai-config.js`, the unit test's ai-config mock must export it too (missing `AI_MODELS` broke 7 tests).

---
name: SparqMake frontend test setup
description: How vitest/jsdom frontend tests are wired for the sparqmake web app and the pitfalls hit while setting them up
---

# SparqMake frontend tests (vitest + jsdom + Testing Library)

The web app has its own `vitest.config.ts` **separate from `vite.config.ts`**.
**Why:** the vite config throws at import time unless `PORT` and `BASE_PATH` env vars are set, so vitest cannot reuse it.
**How to apply:** keep test config standalone (react plugin + `@` alias + jsdom + `src/test/setup.ts`); run via `pnpm --filter @workspace/sparqmake test`.

Pitfalls encountered:
- With `test.globals` unset/false, React Testing Library does **not** auto-register its `afterEach(cleanup)`; renders accumulate across tests and queries start matching duplicates or stale DOM. Symptom: tests pass in isolation, fail together. Fix: explicit `cleanup()` in the setup file.
- pnpm needs `@testing-library/dom` as an explicit devDep — `@testing-library/react` treats it as a peer and it isn't hoisted.
- Radix UI in jsdom needs polyfills: ResizeObserver, `scrollIntoView`, pointer-capture methods, `matchMedia` (all in `src/test/setup.ts`).
- Real `AuthProvider` can be used in tests by stubbing global `fetch` for `/api/auth/me` — no need to mock the auth hooks, so `useCanWrite`/role logic is exercised for real.
- Generated `@workspace/api-client-react` hooks are mocked per-test-file; remember list hooks return `{ data: { data: [...] } }` (the wrapper) while `useGetBrands` returns a bare array.

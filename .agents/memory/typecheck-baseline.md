---
name: Monorepo typecheck baseline (now green)
description: The repo-wide `pnpm run typecheck` baseline was red; it has since been fixed to exit 0. What the root causes were and how to keep it green.
---

`pnpm run typecheck` at repo root now exits 0. It used to be RED at baseline.

**Root causes that were fixed:**
- `lib/api-zod`: generated code referenced global `File`/`Blob` but its tsconfig
  `lib` lacked DOM → fixed by setting `lib: es2022 + dom`; also deduped duplicate
  codegen exports in its `index.ts`.
- `lib/integrations-anthropic-ai` and `lib/integrations-gemini-ai` set
  `types: ["node"]` but never declared `@types/node` → added the dep.
- `p-retry` v7 `AbortError` shape change required a small fix.
- Once the libs emitted `dist/*.d.ts`, the TS6305/TS2305 cascade in
  `artifacts/api-server` cleared, exposing ~120 real errors there (drizzle
  `string | string[]` query params, json casts, TS7030 missing returns, etc.) —
  all fixed.
- `artifacts/sparqmake` frontend had ~70 errors, fixed (see api-client-data-wrapper.md).

**How to apply:** The global typecheck is now a trustworthy gate again — a red
result means a real regression. Still fastest to validate by running the changed
package's typecheck and grepping for your file paths, but exit 0 repo-wide is
the expectation now, not the exception.

---
name: Monorepo typecheck baseline is red
description: Why `pnpm run typecheck` fails repo-wide independent of any given change, and how to tell a real regression from the cascade.
---

The repo-wide `pnpm run typecheck` is RED at baseline, unrelated to most tasks.

**Root cause chain:**
- `typecheck:libs` (`tsc --build`) fails first in `lib/api-zod` (generated code
  references global `File`/`Blob` but `tsconfig.base.json` has `lib: ["es2022"]`
  and `types: []`, so they're undefined; plus duplicate codegen exports).
- `lib/integrations-anthropic-ai` and `lib/integrations-gemini-ai` set
  `types: ["node"]` in their tsconfig but do NOT declare `@types/node` as a
  dependency → "Cannot find type definition file for 'node'".
- Because the libs never emit `dist/*.d.ts`, every artifact that imports them
  gets cascade errors: TS6305 ("output file has not been built") and TS2305
  ("no exported member") across many untouched route files in api-server.
- Many route files also have TS2769 drizzle overload errors from passing
  `string | string[]` query params straight into `eq()`.

**How to apply:** When validating a change, don't trust the global typecheck
pass/fail. Instead run the specific changed package's typecheck and grep the
output for YOUR changed file paths. If your files produce no errors, the red
baseline is not your regression. Fixing the baseline (api-zod codegen lib/types,
integration lib deps, query-param typing) is a separate, large effort.

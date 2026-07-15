---
name: CJS bundle dirname & asset resolution
description: How to resolve module-relative paths/assets safely across ESM dev (tsx) and the esbuild CJS production bundle
---
The api-server prod build (build.ts) bundles to a single `dist/index.cjs` via esbuild `format: "cjs"`. In that bundle `import.meta` is rewritten to `{}`, so `fileURLToPath(import.meta.url)` throws ERR_INVALID_ARG_TYPE at module load and crashes the whole server at startup.

**Rule:** for module-relative paths, prefer `import.meta.url` when truthy and fall back to `__dirname` only when it isn't. Do NOT guard with `typeof __dirname !== "undefined"` first — tsx defines a bogus `__dirname` in ESM, so that guard picks the wrong branch in dev.

**Assets:** the bundle is a single file — any runtime-read assets (e.g. `src/assets/fonts`) must be explicitly copied into `dist/` by build.ts, and resolution must try both the dev layout (`<moduleDir>/../assets/...`) and the bundle layout (`<distDir>/assets/...`), throwing a clear error if neither exists. Resolve lazily (on first use), not at module load, so a missing asset degrades one feature instead of killing startup.

**How to apply:** whenever adding server code that reads files relative to its own source, or adding new bundled assets, verify with a prod-style run: `npx tsx build.ts && node dist/index.cjs`.

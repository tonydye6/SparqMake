---
name: api-zod multipart name collision
description: Adding a multipart/form-data endpoint to the OpenAPI spec breaks api-zod typecheck until the body name is explicitly re-exported.
---

When you add a `multipart/form-data` request body to `lib/api-spec/openapi.yaml`, orval generates a `<OperationName>Body` member in BOTH `lib/api-zod/src/generated/api` (the zod schema) and `lib/api-zod/src/generated/types` (the TS type). The two `export *` lines in `lib/api-zod/src/index.ts` then make that name ambiguous and `pnpm run typecheck` fails with TS2308.

**Fix:** add the new `<OperationName>Body` name to the explicit re-export block in `lib/api-zod/src/index.ts` (the one that already lists `GenerateVideoBody`, `UploadFileBody`, `UploadVariantAudioBody`).

**Why:** orval emits multipart bodies as both a runtime zod object and a TS type with the same identifier; the explicit re-export picks the zod runtime one and resolves the ambiguity.

**How to apply:** after codegen, if typecheck reports "Module ./generated/api has already exported a member named 'XxxBody'", append `XxxBody` to that re-export list.

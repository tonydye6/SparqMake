---
name: api-client-react list endpoints return a { data: [...] } wrapper
description: List endpoints (creatives/assets/templates/hashtag-sets) return a paginated wrapper, now correctly declared in the OpenAPI spec and generated types.
---

For list endpoints (creatives, assets, templates, hashtag-sets), the API server
returns a paginated wrapper object: `{ data: T[], total, limit, offset }`, NOT a
bare array. The OpenAPI spec (`lib/api-spec/openapi.yaml`) declares this via named
`*ListResponse` schemas, so the generated `@workspace/api-client-react` hooks now
return the wrapper type directly — `useGetCreatives().data` is the wrapper, and
`.data.data` is the array.

**Why this matters:** The spec used to declare these responses as bare arrays,
which was wrong. The frontend (correctly) accesses `xxx.data.map/.filter/.find`,
so the wrong type forced ugly `as unknown as { data?: { data?: T[] } }` casts at
every call site. Those casts have been removed now that the types are correct.

**How to apply:** If you add or change a paginated list endpoint, declare its
response with a `{ data: array, total, limit, offset }` wrapper schema in the
OpenAPI spec (mirror the `res.json({ data, total, limit, offset })` shape in the
api-server route), then regenerate with `pnpm --filter @workspace/api-spec run codegen`.
Never hand-edit files under `lib/*/src/generated`. Do not delete `.data` access in
consumers to satisfy the type checker — fix the spec instead.

**Related quirk:** generated `useGetXxx` hooks' `options.query` type requires
`queryKey`, so passing just `{ enabled: ... }` fails typecheck; cast the options
(see `useGetStyleProfiles` usage in `StudioNext.tsx`) or include a queryKey.

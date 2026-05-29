---
name: api-client-react generated types vs runtime wrapper mismatch
description: The generated react-query hooks declare bare arrays, but the server actually returns a { data: [...] } wrapper. Trust runtime, not the generated type.
---

For list endpoints (creatives, assets, templates, hashtag-sets), the generated
`@workspace/api-client-react` hooks declare the response as a bare array
(e.g. `getCreatives(): Promise<Creative[]>`), but the API server actually
returns a paginated wrapper object: `{ data: Creative[], total?, limit?, offset? }`.

**Why this matters:** The sparqmake frontend was written against the real runtime
shape — it accesses `xxx.data.map/.filter/.find`. That is RUNTIME-CORRECT.
The generated types are WRONG. So `xxx.data` raises a TS error ("data does not
exist on Creative[]"), tempting you to "fix" typecheck by deleting `.data`.
**Deleting `.data` makes typecheck pass but breaks the app at runtime**
(`xxx.filter is not a function`, because `xxx` is the wrapper object, not an array).

**How to apply:** Keep the `.data` access. Satisfy the type checker by casting the
hook result to the wrapper shape at the call site, preserving any other destructured
fields, e.g.:
`const { data: creatives, isLoading } = useGetCreatives() as unknown as { data?: { data?: Creative[] }; isLoading: boolean };`
Child components in creative-studio (CreativeConfigPanel) already expect the
wrapper (`{ data?: T[] } | undefined`); pass the variable through directly.
The proper long-term fix is correcting the OpenAPI spec + regenerating so the
types declare the wrapper — but generated files under `lib/*/src/generated` must
not be hand-edited.

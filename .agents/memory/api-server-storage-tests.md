---
name: api-server storage testing + ownership model
description: Durable gotchas for testing the storage service and why file ownership is reference-based
---

- **The storage service binds its disk root from `process.cwd()` at module load.**
  Any test must set the backend env vars and `chdir` into a throwaway dir *before*
  the dynamic `import` of the storage module, or it locks onto the package dir and
  pollutes the real uploads tree. To exercise the bucket path instead, mock the
  Object Storage client and provision the bucket env var before that same import.

- **There is no user→brand tenant model in SparqMake** (users carry a role only;
  brand context is a client-supplied id), so true per-tenant file isolation is
  impossible without a schema change. Ownership is enforced as the achievable
  gap-closure: a protected file is served only if a DB row references it (else 404),
  which stops arbitrary-id probing. Public/generated media stays unauthenticated.
  **Why:** any authenticated editor can already reach every brand by design, so
  reference-existence is the strongest gate available without new schema.

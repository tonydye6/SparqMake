---
name: Object Storage SDK method binding
description: "@replit/object-storage Client methods dereference `this`; never pass them around as bare function references"
---

# @replit/object-storage SDK — method binding

**Rule:** Always invoke `@replit/object-storage` Client methods as methods on the client instance (`client().downloadAsStream(...)`). Never pull them off as bare function references (`const f = client().downloadAsStream; f(key)`), even to work around type gaps — cast the *arguments* instead.

**Why:** The SDK's methods call `this.getBucket()` internally. An unbound call throws `TypeError: Cannot read properties of undefined (reading 'getBucket')`. In the serve path this was uncaught and killed the whole API server process on the first image request, taking the app down until restart.

**How to apply:**
- When the SDK's public types omit real capabilities (e.g. `downloadAsStream(key, {start, end})` — the wrapper passes options through to GCS `createReadStream`, so ranged reads genuinely work), cast the options parameter, not the function itself.
- Test mocks for this SDK should dereference `this` inside methods (like the real SDK) so unbound-call regressions fail the suite — see `storage.bucket-range.test.ts` / `storage.bucket-errors.test.ts`.
- Any bucket serve/read failure must be caught and turned into a per-request error (500/fallback), never allowed to escape as an unhandled rejection.

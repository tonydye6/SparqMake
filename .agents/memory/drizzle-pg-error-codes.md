---
name: Drizzle-wrapped Postgres error codes
description: SQLSTATE codes (23505, 23503) live on err.cause, not err, when drizzle wraps driver errors
---

# Drizzle-wrapped Postgres error codes

Drizzle throws `DrizzleQueryError` wrapping the original driver error; the Postgres SQLSTATE (`23505` unique violation, `23503` FK violation) is on `err.cause.code`, NOT `err.code`.

**Why:** A `has_content` mapping for user deletion silently never fired in live testing — the raw wrapped error leaked through because the check only looked at `err.code`. The same latent bug existed in the invite unique-violation race handler (never caught live because a pre-check normally intercepts duplicates).

**How to apply:** When mapping DB constraint violations to domain errors, check both `err.code` and `err.cause?.code` (see `pgErrorCode()` in api-server's user-management service — reuse or copy that pattern). Unit tests that only fabricate flat `{code: "23503"}` errors will pass while the live path fails; add a wrapped-cause test case too. Live-verify constraint paths with a real DB when possible.

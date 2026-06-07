---
name: api-server local endpoint testing
description: How to hit api-server routes locally with curl despite auth/origin guards
---
The api-server requires an `Origin` header on requests even when `DEV_AUTH_BYPASS=true`
(a requireOrigin guard runs separately from auth). Missing origin → 403
`{"error":"Forbidden: missing origin header"}`.

**How to apply:** when curling the running dev server (port from PORT, e.g. 8080), send
`-H "Origin: http://localhost"` — `http://localhost` is always in the allowed-origins
list (see `src/lib/allowed-origins.ts`). With DEV_AUTH_BYPASS set, that's enough to reach
protected routes without real auth.

---
name: audit logging for privileged/destructive mutations
description: How the API-server audit trail is designed and the constraints that govern it
---

# Audit logging (SparqMake API server)

Durable audit trail for privileged & destructive mutations lives in the
`audit_logs` table (schema: `lib/db/src/schema/audit-logs.ts`) and the helper
`artifacts/api-server/src/lib/audit.ts` (`recordAudit`, `actorFromRequest`).

## Non-obvious constraints
- **Audit writes must never break the primary op.** `recordAudit` swallows all
  errors (returns bool, logs at error level) and must be called AFTER the
  primary mutation succeeds. Never wrap the primary op's success on the audit
  write.
- **`brandId` is nullable text with NO foreign key** — reserved for future
  tenancy. Do not add an FK; the app has no user→brand tenant model yet.
- **`affectedCount` defaults to `entityIds.length`** — pass it explicitly only
  when the count differs from the ids recorded (e.g. bulk ops that record a
  subset).
- **No-op deletes must not audit.** Routes only record when the delete/update
  actually returned rows (e.g. a 404 delete records nothing) — tests enforce this.

## Gotchas when instrumenting routes
- **content_plan items have no `brandId`** (only `brandLayer`), so
  content_plan.delete audit records omit brandId. Check the schema before
  assuming a brand column exists.
- Helper supports action `"user.role_change"` but there is no user-management /
  role-change endpoint yet — wire it up when that route is added.

## Testing pattern that works
`src/lib/audit.test.ts`: set `DEV_AUTH_BYPASS=true` before imports; vi.mock
`@workspace/db` (export `db` + table sentinels by identity), `drizzle-orm`
(operators as no-op stubs), `../services/storage.js`, and
`../services/publish-scheduler`. Capture audit inserts by table identity
(`table === auditLogsTable`). Extract terminal route handlers via
`router.stack.find(l => l.route?.path===path && l.route.methods[method])`, take
the last handler in `route.stack`, and call it with mock req/res. Avoid
importing `templates.ts` router (pulls in claude/genai refinement-analysis).

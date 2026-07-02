---
name: Publish failure alerting
description: Design constraints for the failed-scheduled-publish alert pipeline (grouping, cooldown, retry interplay, SMTP degrade)
---

# Publish failure alerting

The api-server alert sweep for permanently failed scheduled publishes has invariants future changes must preserve:

- **Permanent failure definition**: retries exhausted (retryCount >= MAX_RETRIES from `publish-constants`) OR no social account attached (scheduler's retry filter skips those, so they never retry). Both must be treated as alertable or NULL-account failures rot silently.
- **Spam control is two-layer**: failures grouped per social account per sweep, AND a 30-minute per-account cooldown enforced via `publish_alerts` rows. Entries stay `alerted_at IS NULL` during cooldown so they're picked up by the next eligible sweep — don't mark them alerted early.
- **Retry interplay**: any retry action must reset `alerted_at` to NULL alongside publishError/retryCount, otherwise a second permanent failure after a manual retry never re-alerts.
- **SMTP unconfigured is a supported state**: email service degrades gracefully (throttled warn log); entries remain un-alerted until SMTP_HOST + SMTP_FROM are set, then the next sweep sends. UI surfaces "email not configured" hints.
- **Extensibility**: alert delivery goes through a channel abstraction (channel name stored on publish_alerts rows) so Slack/webhooks can be added without schema changes.
- **Audit hygiene**: alert audits record counts/ids only — never recipient emails or tokens.

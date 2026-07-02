---
name: Social credential resolution
description: How social platform OAuth credentials are resolved and gotchas about secret visibility and placeholder values
---

# Social credential resolution

All social platform (X/Twitter, Instagram, LinkedIn, TikTok, YouTube) OAuth credentials must be read via the central resolver in the api-server `social-credentials` service — never `process.env.SparqMake_*` / `SparqForge_*` directly.

**Why:** The SparqForge→SparqMake rename left secrets stored under a mix of both prefixes. The resolver accepts canonical (SparqMake) names with legacy (SparqForge) aliases, so either works. Direct env reads reintroduce the "not configured" bug in prod.

**Gotchas discovered:**
- `viewEnvVars` does NOT list all secrets visible to the process. Account-level secrets (e.g. `SparqForge_Instagram_App_ID`, `SparqForge_LinkedIn_Client_ID`) exist in `process.env` but were absent from the viewEnvVars listing. To know what a running server actually sees, check `process.env` directly via node.
- Some stored secrets contain placeholder values (e.g. Instagram App ID literally `INSTAGRAM_APP_ID`). The resolver treats ALL_CAPS_WITH_UNDERSCORES values and your_/changeme/placeholder patterns as unconfigured so the UI/status endpoint reflects reality.

**How to apply:** New social platform credential consumers import `getSocialCredential` / `getPlatformConfigStatus`. The `GET /api/social-platforms/status` endpoint returns names/labels only — never secret values.

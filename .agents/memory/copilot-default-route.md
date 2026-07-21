---
name: Co-pilot Studio as default route
description: /copilot swapped to /; StudioNext at /studio; api-zod voiceExamples manual patch
---

## Route layout (after Phase 3)
- `/` — CopilotStudio (Co-pilot Studio)
- `/studio` — StudioNext (legacy "Creative History", read-only history of old beat-walk takes)
- `/copilot` — `<Redirect to="/" />` (backward compat)

**Why:** Phase 3 task retired the beat-walk UI as the default. Old creatives remain viewable at /studio.

## voiceExamples in api-zod
`voiceExamples` was manually added to `lib/api-zod/src/generated/api.ts` in GetBrandResponse, UpdateBrandBody, and UpdateBrandResponse. The codegen source does not include it. A future codegen run will drop it. Tracked in follow-up #226.

**How to apply:** Any brand-related api-zod regeneration must re-add voiceExamples manually or fix the source spec first.

## ContentPlan deep-link flow
ContentPlan still navigates to `/?campaign=<creativeId>`. CopilotStudio root component reads this on mount, fetches the creative, and auto-starts a session. This creates a second "session creative" separate from the plan item's linked creative — follow-up #224 covers fixing that with existingCreativeId support.

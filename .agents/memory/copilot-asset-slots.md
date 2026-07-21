---
name: Copilot attached-asset slots
description: How library assets reach the image model in Co-pilot edit turns
---
Edit turns (`edit_image`, `edit_region`) previously sent text only — the model hallucinated logos/assets. Now `loadAttachedAssetSlots` (session-service) turns brand assets into `ImageSlot` entries (slot "object", faithful-reproduction description).

**Rules:**
- Sources: explicit `assetIds` from the composer paperclip picker (max 3), OR auto-match asset names mentioned case-insensitively in the instruction.
- Always brand-scoped server-side (creative.brandId); cross-brand ids are silently dropped.
- Only `image/*` assets become slots (mime from row or filename); non-images are skipped with a warning.
- Frontend picker state resets on session switch (different session may be a different brand).

**Why:** "compositing" assets (logos) are never auto-sent to the model; without explicit slots the model invents its own version of the asset.

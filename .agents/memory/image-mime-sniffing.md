---
name: Image mime sniffing for model calls
description: Why model-bound images must use magic-byte-sniffed mime types, not stored ones
---
Anthropic hard-rejects base64 images whose declared media_type mismatches the actual bytes (400 invalid_request_error). Our image model sometimes returns JPEG bytes that get saved under .png names, so stored mimeType/extension lies.

**Rule:** any time an image buffer is sent to a model API, derive the mime via `sniffImageMime(buf)` (magic bytes: PNG/JPEG/GIF/WEBP, exported from session-service) and only fall back to the stored value.
**How to apply:** new model-call sites that attach images must sniff; do not trust asset/variant mimeType columns or filenames.

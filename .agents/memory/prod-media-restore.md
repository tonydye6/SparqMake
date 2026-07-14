---
name: Prod media restore path
description: How to restore missing production media — bucket is shared dev/prod; dev uploads/ tree is the restore source.
---

The Object Storage bucket (DEFAULT_OBJECT_STORAGE_BUCKET_ID) is shared between dev and production, so uploading a file to the bucket from dev immediately fixes prod serving — no prod deploy or DB write needed.

**Why:** Pre-bucket files lived on ephemeral deployment disk and were wiped on republish; the dev workspace `artifacts/api-server/uploads/` tree still holds most of them and is the only surviving restore source.

**How to apply:** Compare prod DB file references (read-only `executeSql environment:"production"`) against bucket keys, then `uploadFromFilename` any dev-disk survivors. Media generated only in prod during the disk-backend era is unrecoverable (28 generated/* creative-variant images as of Jul 2026); prod DB is read-only for the agent so their dangling URLs can't be cleared — handle in UI. Import `@replit/object-storage` in code_execution via `createRequire("/home/runner/workspace/artifacts/api-server/package.json")`.

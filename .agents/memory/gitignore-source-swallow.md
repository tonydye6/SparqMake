---
name: Gitignore patterns can swallow source files
description: Broad .gitignore patterns like *credentials* silently drop source files from commits; the merge "succeeds" but the file is lost
---

# Gitignore patterns can swallow source files

The root `.gitignore` has broad secret-hygiene patterns (`*credentials*`, `*keys*.txt`). A pattern like `*credentials*` once matched a real TypeScript service file (`social-credentials.ts`), so the task that created it committed everything EXCEPT that file. The merge looked successful, but every fresh environment failed typecheck/tests with "Cannot find module".

**Why:** git silently skips ignored files; nothing warns when a new source file matches an ignore pattern.

**How to apply:**
- Negations `!*credentials*.ts` / `!*credentials*.tsx` now follow the pattern — keep them if the secret-hygiene patterns are edited.
- When adding a source file whose name matches words like "credentials", "keys", "secret", run `git check-ignore -v <path>` before finishing.
- If a merged commit references a module that doesn't exist, suspect gitignore swallowing before suspecting a bad merge; the file may be unrecoverable and need reconstruction from its consumers.
- `social-credentials.ts` in api-server was reconstructed from consumer call sites (getSocialCredential/getPlatformConfigStatus/getTwitterOAuth1Credentials) — if social OAuth behaves oddly, verify its env-name tables against actual secrets.

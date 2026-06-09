---
name: stale github remote-tracking locks
description: Recurring stale .git/refs/remotes/github/*.lock files silently break fetch/merge; only a task agent can clear them.
---

# Stale `github` remote-tracking lock files

Crashed/interrupted git processes leave behind `.git/refs/remotes/github/main.lock`
(and sometimes `master.lock`). While present, they **pin `github/main` at a stale
commit**, so `git fetch github` becomes a silent no-op and any subsequent
`merge github/main` brings in nothing — yet the merge reports "Already up to date"
/ a clean fast-forward, so the operation *looks* successful.

**Why this matters:** this has caused convergence/merge tasks to falsely report
success while the expected files never landed (e.g. an Object Storage PR whose
`scripts/upload-assets-to-bucket.ts` + `@replit/object-storage` dep + bucket-backed
route were all absent afterward, with master still at the pre-merge tip and the
remote SHA absent from the local object DB).

**Hard constraint:** the **main agent cannot fix this**. All destructive git is
sandbox-blocked for the main agent, *including* `rm` of files under `.git/` — the
block message is literally "Destructive git operations are not allowed in the main
agent." Only an **isolated background task agent** can remove the locks, re-fetch,
and merge.

**How to apply:**
- If a merge "succeeds" but expected files/deps are missing, suspect stale locks.
  Diagnose read-only: `ls -la .git/refs/remotes/github/` (look for `*.lock`), and
  `git rev-parse github/main` vs the expected remote SHA.
- Route the actual fix through a task agent, and make it **verify `github/main`
  resolves to the EXACT expected SHA after fetch, and STOP if not**, before merging.
- After the merge, verify the expected new files/deps actually exist in the working
  tree rather than trusting "fast-forward / up to date".

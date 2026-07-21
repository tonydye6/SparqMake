---
name: GitHub push refspec
description: How to push this Repl to its connected GitHub repo (tonydye6/SparqMake)
---
# Pushing to GitHub (tonydye6/SparqMake)

The Repl's local primary branch is `master`, but the GitHub remote's default
branch is `main`. A plain `git push github` will not line them up.

**How to apply:** push with an explicit refspec: `git push github master:main`.
Both `github/main` and `github/master` have historically been ancestors of local
`master`, so this fast-forwards (no force needed). Verify with
`git ls-remote github refs/heads/main` rather than trusting local tracking refs.

**Why:** a stale lock on `.git/refs/remotes/github/main.lock` can make the push
print a non-fatal "cannot lock ref" error *after* the remote already updated —
the remote push still succeeds. Clear the lock and `git update-ref` the tracking
ref manually; confirm success via `ls-remote`, not the local error message.

**Fetch-side trap (bit me once):** the same stale `.lock` files make `git fetch`
silently *fail to update* `github/main` ("unable to update local ref"), so the
local tracking ref stays pinned at a weeks-old commit. Every downstream check
(merge-base, ancestry, "already up to date") is then computed against the wrong
tip and looks nonsensical. If a push dry-run says "non-fast-forward" but local
ancestry says it should be clean, suspect a pinned tracking ref: `rm` the stale
`.git/refs/remotes/github/*.lock`, re-fetch, and re-verify before concluding.

**Merge trap (July 2026 sync):** merging remote-only GitHub commits can re-add
code the local branch already superseded via refactor — e.g. a duplicate
Express route referencing symbols (`UPLOAD_DIR`) that no longer exist. git's
merge is textual, not semantic, and won't conflict on this. After any
`git merge github/main`, run repo-wide typecheck before pushing; delete the
redundant remote version when local abstraction (storage service) already
covers the behavior.

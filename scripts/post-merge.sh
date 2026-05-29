#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply versioned migrations (forward-only). Schema changes must ship as a
# generated drizzle migration; `push` is for local/dev iteration only.
pnpm --filter db migrate

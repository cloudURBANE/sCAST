#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Schema push is guarded (lib/db/scripts/preflight-push.mjs): it refuses a
# non-local DATABASE_URL unless ALLOW_PROD_DB_PUSH=yes, so a merge never quietly
# rewrites a shared/prod schema. Kept non-fatal (|| ...) so a refusal — or any
# push hiccup — does not break your merge. Auto-pushes only against a local dev DB.
pnpm --filter @workspace/db run push || echo "[post-merge] schema push skipped — see message above"

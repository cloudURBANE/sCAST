# ScentCast — Operator Launch Setup

This is the **non-code** checklist an operator (repo owner) completes to take
ScentCast from "public-ready in code" to "live for real users." The P0 code
changes (CORS allowlist, security headers, verified DB TLS, token hashing +
expiry, one-time OAuth handoff, auth/write rate limits, account deletion +
export) have already landed; the steps below are the dashboard/DNS/one-time
operations that only the owner can do.

Design of record: `docs/PRODUCTION_READINESS_PLAN_2026-07-07.md`.

> Ordering matters: do **1 (Railway env) → 2 (Google) → 3 (DB migration)**
> before flipping DNS, then **4 (AWS cutover)**. The engine (5), legal (6), and
> CSP flip (7) can proceed in parallel once the app is up.

---

## 1. Railway — api-server environment

Set these in the Railway service for the Express API. Missing image-storage
credentials in particular will break **every** fragrance image, so treat the
storage trio as mandatory in production.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres (Supabase) connection string. |
| `DATABASE_SSL_CA` | Provider CA cert (inline PEM with `\n` escapes, or a file path) so DB TLS is **verified**, not just encrypted. Supabase: Project Settings → Database → SSL → download CA. Without it the server boots with relaxed TLS and logs a warning — treat that as a deploy TODO. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app credentials. |
| `OAUTH_PUBLIC_URL` | Canonical public URL of the app (e.g. `https://app.example.com`). Used to build the OAuth redirect URI. |
| Image storage (**mandatory in prod**) | Firebase Storage **or** Supabase Storage credential set. Pick one and set its full trio/group — see `.env.example`. |
| `SERPER_API_KEY` (or `SERPER_API_KEYS`) | Image search (Serper.dev). |
| `TRUST_PROXY_HOPS` | `2` behind the CloudFront/edge → Railway chain (so per-IP rate limits read the real client IP). |
| `CORS_ALLOWED_ORIGINS` | Leave **empty** if the SPA is same-origin via the CloudFront `/api/*` proxy. Set exact origins only if a browser app on another origin must call the API. |
| `TOKEN_ABSOLUTE_TTL_DAYS` / `TOKEN_IDLE_TTL_DAYS` | Bearer-token lifetime (defaults 90 / 30). Optional. |
| `OAUTH_RATE_LIMIT` | Per-IP 10-min cap on the auth surface (default 20). Raise for a large shared NAT. |
| `WARDROBE_WRITE_RATE_LIMIT` / `COMMUNITY_WRITE_RATE_LIMIT` | Per-user write caps (defaults 120 / 60 per minute). Optional. |
| `ENRICHMENT_QUEUE_ENABLED=true` **and** `ENRICHMENT_WORKER_ENABLED=true` | Enable both together — the producer and consumer are each gated OFF by default. |
| `ADMIN_EMAILS` | Comma-separated admin allowlist (fully env-driven; no owner address is baked into source). |
| `ADMIN_SECRET` | Shared secret for the ops-only wardrobe rebuild route. |
| `HSTS_ENABLED` | Leave `false` behind CloudFront/Railway (the edge sets HSTS). |

Railway healthcheck path is already `/api/readyz` (`railway.json`).

**If a separate "Beam MCP" Railway service runs from this same image**
(overridden start command), its start command must change from
`pnpm --filter @workspace/api-server run start:beam-mcp` to
`pnpm run start:beam-mcp`. The Dockerfile's runtime stage (G1, multi-stage
non-root rebuild) is now a pruned, standalone `@workspace/api-server`
package with no `pnpm-workspace.yaml` alongside it, so a `--filter`
invocation can no longer resolve — update that service's dashboard config
in the same deploy that ships the new image. Also confirm
`BEAM_AGENT_TOKEN_SECRET` is set on that service (it refuses to start
without it).

---

## 2. Google Cloud Console

Register the OAuth redirect URI for the canonical host:

```
https://<public-host>/api/auth/google/callback
```

(Match `OAUTH_PUBLIC_URL` exactly, including scheme and host.)

---

## 3. Database migration

Apply the committed SQL migrations to the live DB, including the new
`supabase/migrations/20260707120000_user_token_hash_and_expiry.sql` (adds
`token_hash`, `token_issued_at`, `token_last_used_at`, and the hash index).

The token-hash column is **additive and nullable**; auth authenticates by hash
first and falls back to the plaintext `token` column, and every login backfills
the hash for that row. So the app works immediately after the migration with no
bulk backfill.

**Then adopt the versioned-migration journal** (one-time): verify the live
schema matches the head of `lib/db/migrations/` (spot-check the `users`
token-hash columns), then stamp it as applied —
`ALLOW_MIGRATION_STAMP=yes DATABASE_URL=<prod> pnpm --filter @workspace/db run migrate:stamp`.
From then on every schema change ships as a reviewed SQL file in
`lib/db/migrations/` (CI fails schema edits that arrive without one) and is
applied with `pnpm --filter @workspace/db run migrate` — or automatically at
deploy by setting `RUN_MIGRATIONS_ON_BOOT=true` on the Railway api-server
service. Details: `lib/db/migrations/pre-baseline/README.md`.

**Follow-up (after ≥1 release of dual-read), scripted and documented separately:**

1. Backfill `token_hash` for any rows that haven't logged in:
   `UPDATE users SET token_hash = encode(digest(token::text, 'sha256'), 'hex') WHERE token_hash IS NULL;`
   (requires `pgcrypto`; or run the equivalent from a Node script using the
   app's `hashToken`).
2. Once every active token authenticates by hash, drop the plaintext column:
   `ALTER TABLE users DROP COLUMN token;` — **only** after confirming no
   sessions still rely on the plaintext fallback.

Do **not** drop the plaintext column as part of launch.

---

## 4. AWS CloudFront cutover

Follow `docs/aws-migration/CUTOVER.md`. In brief:

1. Set the GitHub Actions secrets/vars the workflow needs.
2. `terraform apply` — this picks up the security-header response policies in
   `infra/cloudfront.tf` (HSTS, nosniff, frame DENY, Referrer-Policy,
   Permissions-Policy, and **CSP in Report-Only** on the HTML policy).
3. Point DNS at the CloudFront distribution; verify the site + `/api/*` proxy.
4. **Post-cutover, as a separate gated commit** (per `infra/README.md`): delete
   `vercel.json` and `middleware.js`, remove the temporary OIDC trust subject
   from `infra/iam_oidc.tf` (tighten `github_deploy_refs` to `main`), and
   decommission Vercel. These file deletions are intentionally **not** done in
   code yet — they are gated on a verified cutover.

---

## 5. Engine (srt-scent-engine) — Railway env + ops

Per `srt-scent-engine/DEPLOY.md` → "Public launch checklist":

- Env: `FRONTEND_ORIGINS` = the prod SPA origin, Decodo credentials (+ verify
  them live), `DATABASE_URL`, `ENRICHMENT_WORKER_TOKEN`, `DB_POOL_MAX_SIZE=10–15`.
- The engine is intentionally **keyless / no rate limiting** for browser calls;
  request quota lives in the web layer.
- Then run the pending ops items: E-1 heal sweep, E-5 local worker, E-8 live
  cold-search budget validation (use the `engine-live-verify` skill — cached
  tests don't count).

---

## 6. Legal

Replace the placeholder Terms/Privacy copy and contact email in
`artifacts/scent-cast/src/pages/legal.tsx` with counsel-reviewed text before
inviting the public.

---

## 7. Content-Security-Policy — enforce flip

CSP ships as **Report-Only** first (in `infra/cloudfront.tf`). Watch the
violation reports for at least a week, fix any legitimate blocked origins, then
flip the HTML policy from report-only to enforcing. Out of scope for launch.

---

## Post-deploy smoke test

A real OAuth round-trip needs production Google credentials, so it can't run
offline. After deploy, walk this by hand on the live host:

1. **Login** — click sign in with Google → consent → land back signed in. The
   URL should carry `?oauth_code=…` briefly, then scrub to a clean path (no
   token/email left in the URL).
2. **Search** — search a fragrance; results load (engine reachable).
3. **Add to wardrobe** — add a result; it appears with an image.
4. **Reload** — the wardrobe persists (token in localStorage still valid).
5. **Export** — Settings → Data & account → Export my data downloads a JSON
   file with your rows and **no** token/token_hash.
6. **Delete account** — Settings → Data & account → Delete → confirm. You're
   signed out; a reload shows the signed-out state and the account is gone.

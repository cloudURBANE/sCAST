# Secrets Rotation Runbook (readiness gap X4)

One page per credential family: where it lives, how to rotate it, and what it
is **paired** with. Goal: a leaked-key incident is minutes of lookup, not an
evening of archaeology. Covers **both services** (sCAST web on Railway +
CloudFront, `srt-scent-engine` on Railway).

General procedure for every entry: mint new → set in the config store(s) →
redeploy/restart the consumer(s) → verify → revoke old. Rotate in that order so
there is no gap; nothing below requires downtime unless noted.

| Secret | Lives in | Consumers | Rotation | Pairing / notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` (wardrobe, Supabase) | Railway (web service) | Express API | Supabase → Settings → Database → reset password; update URL; redeploy | Shared Supabase project — the OTHER app's services using this DB break until updated too |
| `SUPABASE_SERVICE_ROLE_KEY` | Railway (web) | image storage uploads | Supabase → Settings → API → rotate service_role | Anon/public key is separate and browser-safe |
| `DATABASE_URL` (engine, Railway PG) | Railway (engine service) | engine api/db.py, offline heal scripts | Railway PG → reset credentials; update engine + any local `.env` copies | Local heal scripts (`heal_offline`) carry their own copy — update or they write nowhere |
| `DATABASE_SSL_CA` (both) | Railway (web + engine) | verified DB TLS | Re-download provider CA bundle; not secret, but must match provider | Unset = unverified TLS boot warning |
| Google OAuth client id/secret | Railway (web) + Google Cloud Console | routes/oauth.ts | Console → Credentials → rotate secret; update env; redeploy | Redirect URIs unchanged; sessions survive (bearer sessions are ours, in user_tokens) |
| `ADMIN_SECRET` | Railway (web) | admin routes (timing-safe compare) | Mint new random; update env; redeploy | Also update wherever the operator stores it (password manager) |
| `ENRICHMENT_WORKER_TOKEN` | Railway (engine) **and** the desktop worker's env | engine worker/diagnostics endpoints + worker | Mint new; set BOTH sides; restart both | **Paired** — engine and worker must move together or enrichment halts |
| OpenRouter API key | Railway (web) | Beam Agent (provider.ts) | OpenRouter dashboard → revoke + mint; update env | Beam falls back to error banner on 401 — user-visible, rotate promptly |
| Anthropic API key (if set) | Railway (web) / local Hermes | Beam premium paths, Hermes cockpit | Anthropic console → rotate | Hermes is local-only; its 30d owner token is minted by `mintOwnerToken.ts`, revoke by rotating `BEAM_MCP` signing secret |
| Decodo (`DECODO_API_*`) | Railway (engine) | SERP + image-search + price capture | Decodo dashboard → rotate credentials | Spend kill-switch: `DECODO_DAILY_REQUEST_CAP` |
| Serper key pool (`SERPER_API_KEYS`) | Railway (web) + local `ScentCast.env` | monorepo image pipeline; engine is on Decodo since 2026-06-12 | serper.dev → mint; replace pool entries | The singular `SERPER_API_KEY` in local dev env is stale/exhausted — pool is authoritative |
| `REMOVE_BG_*` key pool | Railway (web) | background removal | remove.bg dashboard | Pool semantics same as Serper |
| Firebase service account (`FIREBASE_*`) | Railway (web) | legacy image storage reads | Firebase console → Service accounts → new key; revoke old | Reads are public-URL based; only uploads need the account |
| VAPID keypair | Railway (web) | web push notifications | `npx web-push generate-vapid-keys`; update env | Rotating invalidates existing push subscriptions — they re-subscribe on next visit |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` (web) + `SENTRY_DSN` (engine) | Railway (both) + build-time Vite var | error tracking | Sentry → Client Keys → rotate | DSNs are low-sensitivity (write-only) but rotate on abuse |
| GitHub→AWS OIDC deploy role | `infra/iam_oidc.tf` (no long-lived key) | deploy workflow | Nothing to rotate — trust is federated. Audit: applied tfvars must list only `refs/heads/main` | The absence of a stored AWS key is the design; do not add one |
| Rakuten / Amazon affiliate creds | Railway (web) | affiliate link builders | respective partner dashboards | Non-blocking if stale — links degrade, app works |

## Where the stores are

- **Railway**: two services (web = sCAST monorepo, engine = srt-scent-engine),
  each with its own Variables tab. `railway variables` CLI works per service.
- **GitHub**: repo secrets only for CI/deploy (AWS via OIDC — no stored key).
- **Vite build-time** (`VITE_*`): non-secret by design (they ship in the
  bundle); listed here only because rotating the Sentry DSN touches one.
- **Local**: `ScentCast.env` (dev) and the desktop worker env — remember these
  hold copies of `SERPER_API_KEYS`, `ENRICHMENT_WORKER_TOKEN`, engine
  `DATABASE_URL`; stale local copies are the classic "rotation missed a spot".

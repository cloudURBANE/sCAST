# What "staging" concretely is (readiness gap X3)

Multiple readiness items say "verify on staging" without defining one. This
page is the decision, so it stops being an open question. The guiding
constraint: single-operator project, two Railway services, one CloudFront
distribution — a full parallel environment would cost more attention than it
saves. Staging is therefore **composed per layer**, not a second copy of prod.

## The decision

| Layer | "Staging" is | How |
| --- | --- | --- |
| Express API (web) | **Railway PR environment** | Enable PR environments on the web service; each PR gets an ephemeral deploy with prod-shaped config (point its `DATABASE_URL` at the scratch Supabase below, never prod) |
| Python engine | **Railway PR environment** | Same mechanism on the engine service; its DB var points at a scratch Railway PG (or none — the engine runs JSON-cache-only without `DATABASE_URL`) |
| SPA | **local Vite against the PR API** | `VITE_*` URLs → the PR environment hostnames; `pnpm --filter @workspace/scent-cast run dev`. No second CloudFront distro — the CDN layer is config-only (Terraform-reviewed) and `vite preview` covers bundle behavior |
| Wardrobe DB | **scratch Supabase project** | Free-tier project, schema created by the versioned migrations (`RUN_MIGRATIONS_ON_BOOT`); doubles as the DR restore-drill target (see `DR_RUNBOOK.md`) |
| CSP / headers | **Report-Only in prod** | The CloudFront HTML policy ships CSP Report-Only until `csp_enforce = true` — prod's own telemetry is the staging signal for S1 |

## What this deliberately does not include

- A standing always-on staging URL (nothing would keep it warm or honest).
- A second CloudFront distribution (Terraform plan/apply review + Report-Only
  CSP covers the risk the distro would).
- Staging data sync from prod (scratch DBs start empty or from a DR-drill
  restore — which is a feature: it exercises the restore path).

## Ops steps to activate (one-time, ~15 min)

1. Railway → each service → Settings → enable **PR environments**.
2. Create the scratch Supabase project; store its URL/keys as the PR
   environment's variables (Railway supports per-environment variables).
3. Document the PR-env hostname pattern in the PR template if it proves useful.

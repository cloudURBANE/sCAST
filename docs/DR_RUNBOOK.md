# Disaster Recovery Runbook

Companion to `docs/PRODUCTION_READINESS_PLAN_2026-07-07.md` (E2). This
documents what's in scope for recovery, what the provider already covers,
and the drill an operator needs to run to turn "backups exist" into a tested
backup story. Sections marked **PENDING (operator action)** require access
this repo/session doesn't have (the live Supabase project, Railway/AWS
consoles) and haven't been executed yet — they're the checklist, not a
report of completed work.

## 1. State inventory

| Store | Source of truth for | Loss impact | Recovery path |
| --- | --- | --- | --- |
| Supabase Postgres | `users`, `user_fragrances`, `global_fragrances`, `image_cache`, `enrichment_jobs`, community/arena tables | **Critical** — user accounts and wardrobes | Provider PITR/backup restore (§2) |
| Object storage (Firebase Storage or Supabase Storage bucket) | Processed fragrance images | **Low** — rebuildable | Re-run through the image pipeline on next request (see §4); worst case is re-processing cost (Serper + Poof), not data loss |
| Redis (when configured) | Rate-limit windows, Beam session memory | **None** — ephemeral by design | None needed; app already treats it as best-effort (`docs/USER_LAUNCH_SETUP.md`, `.env.example`) |
| Client `localStorage` (`scent_token`) | The user's own session | **None** (per-user) | User re-authenticates via Google OAuth (one click) |

## 2. Provider backups — verify and record

**PENDING (operator action).** Log into the Supabase project dashboard →
Database → Backups, and record here:

- Plan tier and its included backup type (daily snapshot vs. continuous
  PITR).
- Actual retention window.
- Whether this is a **shared** Supabase project (per `lib/db/drizzle.config.ts`'s
  `tablesFilter` safety comment — it hosts another app's tables too). If so,
  name who owns restore decisions for the shared instance and the escalation
  path — a restore here can affect that other app.

**Target (decision, not yet verified against the actual plan):**

- **RPO ≤ 24h** (PITR if the plan tier supports it; otherwise the daily
  snapshot cadence).
- **RTO ≤ 4h** for a full restore to a working, servable state.

## 3. Restore drill

**PENDING (operator action) — this is the deliverable that turns "backups
exist" into a tested backup story. Run this once, then calendar a 6-month
re-drill:**

1. Restore the latest backup/PITR point to a **scratch** Supabase project
   (never restore over the live one for a drill).
2. Point a local `api-server` at the scratch project (`DATABASE_URL`
   override only — no other config changes needed).
3. Boot it (`pnpm --filter @workspace/api-server run dev`) and click through:
   Google OAuth login, wardrobe loads, add-to-wardrobe round-trip.
4. Record actual wall-clock time for steps 1–3 here, next to the RPO/RTO
   targets in §2 — that timing *is* the RTO number, not the target.
5. Tear down the scratch project.

## 4. Object storage consistency

`image_cache` rows can reference a storage object that no longer exists
(deleted out-of-band, or a provider outage). This is **not** a hole to patch —
the pipeline already self-heals: `resolveProcessedFragranceImage`
(`artifacts/api-server/src/services/imagePipeline.ts`) re-runs search → Poof
background-removal → sharp → re-upload whenever there's no valid cached
reference, so a missing object is rebuilt on the next request for that
fragrance rather than surfacing as a permanent broken image.

**PENDING (operator action) — verify this once by deleting a real test
object** from the storage bucket and confirming the next request for that
fragrance re-processes it instead of showing a broken image, then record the
outcome here.

## 5. Out of scope for this runbook

- The external fragrance engine (`srt-scent-engine`) has its own database and
  its own recovery story — not covered here.
- Vercel/CloudFront frontend state is stateless static assets; redeploying
  from the `main` branch is the entire recovery path (no drill needed).

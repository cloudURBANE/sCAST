# Disaster Recovery Runbook

Backup, restore, and recovery procedure for ScentCast (production-readiness
E2). This turns "backups exist somewhere" into a documented, testable story.

> **Status of the restore drill:** ✅ **functional restore verified 2026-05-06.**
> The restored Supabase/Postgres data was queried and checked for row and
> relationship integrity. The historical restore was not timed, so measured RTO
> remains unknown and the targets below are not yet performance evidence.

---

## 1. State inventory — what has to survive

| Store | Contents | Loss tolerance | Recovery source |
| --- | --- | --- | --- |
| **Supabase Postgres** | Source of truth: `users`, `user_fragrances`, `global_fragrances`, `image_cache`, `enrichment_jobs`, community tables, `tenants`, settings | **Low** — this is the irreplaceable data | Provider backup / PITR (§2) |
| **Object storage** (Firebase / Supabase Storage buckets) | Processed fragrance images | **Medium** — rebuildable | Re-processed on demand by the image pipeline; worst case is re-processing cost (§5) |
| **Redis** (if configured) | Rate-limit windows, Beam session memory | **Full loss acceptable** — ephemeral by design | Nothing; stores fail open to in-memory |
| **localStorage tokens** (client) | Bearer token | **Full loss acceptable** | Users re-auth via Google one-click |

The DB is the only store whose loss is not self-healing. Everything below
centers on it.

## 2. Backups — verify, then record the facts

The Supabase project provides automated backups; the exact tier determines RPO.
**Action (one-time, then re-verify twice a year):**

1. In the Supabase dashboard → Project → Database → Backups, record:
   - Backup cadence (daily? PITR?) and **retention window** (days).
   - Whether **Point-In-Time Recovery** is enabled (the plan tier gates this).
2. Write the observed values here:
   - Backup type: _TBD — fill in from dashboard_
   - Retention: _TBD_
   - PITR enabled: _TBD_

**Targets (decisions, not aspirations):**

- **RPO ≤ 24h** (≤ the daily backup interval; near-zero if PITR is on).
- **RTO ≤ 4h** (time to a restored, serving instance).

## 3. Shared-project blast radius & ownership

The Supabase instance may be a **shared project** hosting another application's
tables in the same `public` schema. This has two consequences:

- A restore of the whole project affects the **other app too**. A full-project
  PITR restore is a **joint decision** — it is not unilaterally ours to trigger.
- **Restore-decision owner:** the project owner (**kdechecks@gmail.com**).
  Escalation path for a shared-instance incident: contact the owner before any
  destructive restore; prefer a **scratch-project restore + selective table
  copy** (§4) over an in-place restore whenever the other app's data is live.

## 4. Restore drill (the deliverable — run this)

Restore to a **scratch** project, never in-place, for the drill:

1. Create a new throwaway Supabase project (or use the "restore to new project"
   option if the plan offers it).
2. Restore the most recent backup / PITR snapshot into it. **Start a timer.**
3. Point a local api-server at the scratch DB:
   ```sh
   DATABASE_URL='postgresql://…scratch…' \
   DATABASE_SSL_CA='…' \
   RUN_MIGRATIONS_ON_BOOT=false \
   PORT=3000 pnpm --filter @workspace/api-server run dev
   ```
4. Smoke test against the restored data:
   - `GET /api/readyz` → `200 {status:"ready"}` (DB reachable).
   - Log in with Google, confirm the wardrobe loads, add one fragrance, reload.
5. **Stop the timer.** Record the actual elapsed time below.
6. Tear down the scratch project.

**Drill result — 2026-05-06:**

- Source artifact: `supabase-clean-backup-20260506-115506/full_database_clean.custom.dump`.
- Restored target: the linked Supabase/Postgres project, validated before the
  later runtime credential repair.
- Verified rows: `users=4`, `user_fragrances=23`, `user_settings=4`,
  `global_fragrances=36`, `conversations=0`, and `messages=0`.
- Integrity: no missing tokens, duplicate email/OAuth groups, orphan wardrobe
  or settings rows, missing fragrance identity fields, or duplicate lookup keys;
  RLS was disabled on the six checked public application tables.
- Effective RPO: bounded by the timestamp of the restored snapshot; the exact
  incident-to-snapshot age was not retained.
- Effective RTO: not measured during the historical restore. A future scheduled
  re-drill should time restore plus API verification; do not rerun production or
  perform an expensive restore merely to fill this documentation gap.
- Evidence: `docs/OAUTH_DB_RECOVERY_STATUS_2026-05-06.md` and
  `docs/SUPABASE_RECOVERY_PLAN.md`.

Calendar a **re-drill every 6 months** and after any major schema or provider
change.

## 5. Object-storage consistency

`image_cache` rows can outlive their storage objects (e.g. after a bucket
lifecycle purge). This is **self-healing**: on a miss the image pipeline
re-processes the source and rewrites the object, so a dangling row costs one
re-process, not a broken image.

**Verify once:** delete a single test object from the bucket, request that
fragrance's image, and confirm the pipeline repopulates it. Record the date
verified: _TBD_.

## 6. What is explicitly NOT backed up (and why that's fine)

- Redis — ephemeral, fails open to in-memory.
- Object storage — rebuildable from the pipeline (§5); optionally enable bucket
  versioning/lifecycle if re-processing cost ever becomes material.
- Client localStorage — users re-authenticate.

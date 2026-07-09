# Pre-baseline history (not part of the journal)

These SQL files are the hand-applied migrations from the `drizzle-kit push`
era, kept for archaeology only. They are **not** in `meta/_journal.json` and
the migrate runner never executes them.

The journal starts at `../0000_baseline.sql`, generated from the runtime
schema barrel (`src/schema/index.ts`) on 2026-07-07. Databases that already
existed before the journal (provisioned via `push` and `supabase/migrations/`)
adopt it by **stamping**, not applying:

```sh
# 1. Verify the live schema actually matches the journal head (spot-check the
#    users token_hash columns and the newest tables), THEN:
ALLOW_MIGRATION_STAMP=yes pnpm --filter @workspace/db run migrate:stamp
```

Fresh databases skip stamping and just run:

```sh
pnpm --filter @workspace/db run migrate
```

From here on, every schema change is: edit `src/schema/`, run
`pnpm --filter @workspace/db run generate`, review the SQL in the PR (CI fails
schema changes that arrive without a migration), and apply via `migrate` (or
`RUN_MIGRATIONS_ON_BOOT=true` on the server). `push` remains a local-dev
convenience only, still behind its `ALLOW_PROD_DB_PUSH` preflight.

Note `supabase/migrations/` predates this journal too: it remains the record
of what was applied to the shared Supabase project historically, but new
changes land here, not there.

# Pre-baseline migrations (historical)

These SQL files predate the versioned-migration workflow. They were written as
reviewed, hand-applied scripts in the `drizzle-kit push` era and have already
been executed against the production database. They are **not** part of the
drizzle journal (`../meta/_journal.json`) and are never applied by
`pnpm --filter @workspace/db run migrate` — they are kept for the audit trail
only.

Everything they created is also covered by `../0000_baseline.sql`, which is
convergent (IF NOT EXISTS / duplicate_object guards) and therefore safe on both
fresh databases and the already-provisioned production DB.

From the baseline onward, every schema change must ship as a generated
migration: `pnpm --filter @workspace/db run generate` after editing
`src/schema/`, review the emitted SQL, commit it alongside the code.

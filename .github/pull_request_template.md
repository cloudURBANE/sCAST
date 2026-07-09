<!-- Keep the PR small and focused on one logical change. -->

## What & why

<!-- What does this change do, and why? Link any issue. -->

## How verified

<!-- Commands run and their outcome (typecheck / test / build / lint), plus any
     manual or rendered verification. -->

## Checklist

- [ ] Tests added or updated for the change (or N/A with reason)
- [ ] `pnpm run typecheck`, `pnpm run test`, and `pnpm run lint` pass locally
- [ ] Schema change? A migration file is included (`lib/db/migrations/`) — the CI
      guard fails otherwise
- [ ] New env vars are documented in `.env.example`
- [ ] No secrets, tokens, or credentials in the diff

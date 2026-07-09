## Summary

<!-- What changed and why. -->

## Test plan

<!-- Commands run, manual verification, screenshots if UI-facing. -->

## Checklist

- [ ] Tests updated/added for the behavior change (or explain why not needed)
- [ ] `pnpm run typecheck` and `pnpm run lint` pass locally
- [ ] If `lib/db/src/schema/**` changed: a matching file was generated in
      `lib/db/migrations/` (`pnpm --filter @workspace/db run generate`) — CI
      blocks a schema change without one
- [ ] Any new env var is documented in `.env.example` (required vs optional,
      what it degrades to when unset)
- [ ] No secrets, tokens, or real user data in the diff or commit history

# Reference Files Analysis

Folder analyzed: `initial setup ref files for recovery`

This folder is a historical `@workspace/db` package snapshot. It is not imported by current runtime code. It is still valuable because its schema files match the current `lib/db` schema, confirming the app-owned public table model.

| File | Purpose | Tables Used | Auth Role | Still Used By Current App? | Confidence | Notes |
|---|---|---|---|---|---|---|
| `package.json` | Historical DB package manifest | None directly | Direct Postgres via `DATABASE_URL` | No direct import from this folder | Medium | Matches current `lib/db/package.json` closely. Historical package only. |
| `drizzle.config.ts` | Historical Drizzle push config | Schema index only | Direct Postgres via `DATABASE_URL` | No | Medium | Same as current config except current runtime DB client has SSL handling in `src/index.ts`. |
| `tsconfig.json` | Historical package TypeScript config | None | None | No | Low | Build config only. |
| `tsconfig.tsbuildinfo` | Generated TS build cache | None | None | No | Low | Generated. Do not use as truth. |
| `src/index.ts` | Historical Drizzle `Pool` and exports | All exported schema tables | Direct Postgres via `DATABASE_URL` | No | Medium | Diff from current: current client parses `sslmode` and supports `DATABASE_SSL_REJECT_UNAUTHORIZED`. |
| `src/schema/index.ts` | Historical schema barrel | `users`, `user_fragrances`, `global_fragrances`, `user_settings` | None | No direct import, but same current export shape | High | Does not export `conversations` or `messages`, same as current. |
| `src/schema/users.ts` | Historical app user table | `public.users` | Custom app auth, not Supabase Auth | No direct import, same current schema | High | Columns: `id`, `email`, `token`, `oauth_provider`, `oauth_subject`, `created_at`. |
| `src/schema/userFragrances.ts` | Historical wardrobe table | `public.user_fragrances`, FK to `public.users` | Bearer token maps to `users.id` | No direct import, same current schema | High | JSONB `fragrance_data` stores full vault item payload. |
| `src/schema/globalFragrances.ts` | Historical catalog table | `public.global_fragrances` | Backend direct DB | No direct import, same current schema | High | Shared catalog keyed by `lookup_key`. |
| `src/schema/userSettings.ts` | Historical share settings table | `public.user_settings`, FK to `public.users` | Bearer token maps to `users.id` | No direct import, same current schema | High | One row per app user. |
| `src/schema/conversations.ts` | Historical chat scaffold table | `public.conversations` | None in current runtime | No | Low | Present in old and current file tree, but not exported by schema index and not used by current app. Backup has 0 rows. |
| `src/schema/messages.ts` | Historical chat scaffold table | `public.messages`, FK to `public.conversations` | None in current runtime | No | Low | Present but not exported or used. Backup has 0 rows. |
| `dist/**` | Generated declarations/maps | Mirrors historical exports | None | No | Low | Generated output. Do not use as source of truth. |

## Current Import Status

No current runtime file imports from `initial setup ref files for recovery`. Current imports use `@workspace/db` and resolve to `lib/db`.

## Reference vs Current Conflicts

- No schema conflicts were found for app-owned public tables.
- Current `lib/db/src/index.ts` is newer because it includes SSL handling for managed Postgres/Supabase pooler URLs.
- `conversations` and `messages` exist as files in both old/current packages but are not exported from `schema/index.ts`; treat as low-confidence legacy scaffold unless the app is changed to use chat persistence.


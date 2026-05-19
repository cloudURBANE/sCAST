# Database Usage Map

## Backup Evidence

Usable backup folder: `supabase-clean-backup-20260506-115506`

| File | Purpose | Notes |
|---|---|---|
| `full_database_clean.custom.dump` | Custom-format pg dump | Preferred restore input for staging clone. |
| `full_database_clean.readable.sql` | Readable SQL dump | Inspection input. Do not paste row data into docs/chat. |

The earlier `supabase-clean-backup-20260506-115351/full_database_clean.custom.dump` is zero bytes and should not be used.

## Inferred Objects

| Object | Type | Current Evidence | Reference Folder Evidence | Backup Evidence | Required Columns | Used By | Required For Login? | Confidence |
|---|---|---|---|---|---|---|---|---|
| `public.users` | table | `routes/oauth.ts`, `routes/admin.ts`, `routes/wardrobe.ts`, `routes/share.ts`; `lib/db/src/schema/users.ts` | Same schema | 4 rows | `id uuid`, `email text`, `token uuid`, `oauth_provider text`, `oauth_subject text`, `created_at timestamp` | Login, token auth, share handles, wardrobe owner lookup | Yes | High |
| `public.user_fragrances` | table | `routes/wardrobe.ts`, `routes/share.ts`; `lib/db/src/schema/userFragrances.ts` | Same schema | 23 rows | `id uuid`, `user_id uuid`, `fragrance_data jsonb`, `created_at timestamp` | Dashboard wardrobe, share page, rebuild, visibility, delete | After login for app boot | High |
| `public.user_settings` | table | `routes/share.ts`; `lib/db/src/schema/userSettings.ts` | Same schema | 4 rows | `id uuid`, `user_id uuid`, `share_hide_images boolean`, `created_at timestamp`, `updated_at timestamp` | Share modal/page settings | Login can work without it, share settings need it | High |
| `public.global_fragrances` | table | `services/catalogService.ts`, `services/imageHydration.ts`; `lib/db/src/schema/globalFragrances.ts` | Same schema | 36 rows | `id uuid`, `lookup_key text`, `name text`, `brand text`, `profile_data jsonb`, `created_at`, `updated_at` | Search cache, image refresh, rebuild, hydration | No | High |
| `public.conversations` | table | Schema file exists but not exported or used | Same file exists | 0 rows | `id integer`, `title text`, `created_at timestamptz` | No current runtime user | No | Low |
| `public.messages` | table | Schema file exists but not exported or used | Same file exists | 0 rows | `id integer`, `conversation_id integer`, `role text`, `content text`, `created_at timestamptz` | No current runtime user | No | Low |
| `auth.users` | Supabase system table | No current runtime code uses Supabase Auth | Backup includes Supabase auth schema | 0 rows | Supabase-managed | Supabase services only | No, for current app | Medium for backup, Low for runtime |
| `storage.buckets`, `storage.objects` | Supabase storage metadata | No current runtime Supabase Storage usage | None | 0 rows | Supabase-managed | None current | No | Low |
| `supabase_migrations.schema_migrations` | migration history | Not used by runtime | None | 2 rows | Supabase migration history | Deployment/history only | No | Medium |
| `bg_cache` | Firestore collection | `services/firebaseCache.ts`, `services/imageHydration.ts`, `services/scentEngine.ts` | None | Not in SQL dump | document fields `cleanImage`, `brand`, `name`, `createdAt` | Bottle image cache | No | High |
| `localStorage.scent_token` | browser storage | `App.tsx` | None | Not DB | token string from `public.users.token` | Session restore | Yes for persisted sessions | High |
| `localStorage.scent_email` | browser storage | `App.tsx` | None | Not DB | email string | UI display/session restore | Indirect | High |
| `sessionStorage.scentcast_wardrobe_refresh_v1` | browser storage | `Wardrobe.tsx`, `imageRefreshSolvers.ts` | None | Not DB | item ID to retry count map | Image refresh UI | No | High |

## Required Constraints/Indexes From Backup And Schema

- `public.users.id` primary key
- `public.users.email` unique
- `public.user_fragrances.id` primary key
- `public.user_fragrances.user_id` FK to `public.users(id)` on delete cascade
- `public.user_settings.id` primary key
- `public.user_settings.user_id` unique and FK to `public.users(id)` on delete cascade
- `public.global_fragrances.id` primary key
- `public.global_fragrances.lookup_key` unique
- Optional legacy chat: `messages.conversation_id` FK to `conversations(id)`

## Important Absence

There are no `.from(...)`, `.rpc(...)`, Supabase client, storage bucket, or Supabase Auth calls in current runtime code. Database access is through Drizzle and `DATABASE_URL`.


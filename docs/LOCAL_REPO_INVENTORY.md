# Local Repo Inventory

## Major Folders

| Path | Classification | Contents | Trust Notes |
|---|---|---|---|
| `artifacts/scent-cast` | Current runtime frontend | React/Vite app, PWA-style UI, Vercel middleware, built `dist` | Source of truth for browser routes and API calls. Ignore `dist` as generated output. |
| `artifacts/api-server` | Current runtime backend | Express API, OAuth, wardrobe/share/search/image/weather routes, services | Source of truth for DB usage, auth behavior, Firebase cache, and env requirements. |
| `lib/db` | Current runtime database package | Drizzle schema and Postgres client | Source of truth for schema shape expected by API. No migrations checked in here. |
| `lib/api-client-react`, `lib/api-zod`, `lib/api-spec` | Generated/supporting code | OpenAPI generated health client/types | Supporting only. Current frontend mostly calls `fetch`/`axios` directly. |
| `lib/integrations-gemini-ai`, `lib/integrations/gemini_ai_integrations` | Integration libraries | Gemini AI wrappers from scaffold | Not used by current app routes inspected for login/wardrobe/image search. |
| `scripts` | Utility scripts | `rebuild-user-wardrobe.ts`, hello script, db-ping package | Supporting diagnostics. `rebuild-user-wardrobe.ts` calls live API and can create login rows via `/api/auth/login`. |
| `supabase` | Temp Supabase metadata | `.temp` project/version files | Not schema truth. Do not use `.temp` as recovery input. |
| `supabase/recovery` | Recovery artifacts | Safe SQL helpers and README created for this task | Helpers only. Primary 1:1 restore is from the old backup dump. |
| `supabase-clean-backup-20260506-115506` | Old database backup | `full_database_clean.custom.dump`, `full_database_clean.readable.sql` | Best evidence for old data state. Use this for staging clone. Do not commit secrets or expose row values. |
| `supabase-clean-backup-20260506-115351` | Failed/empty backup attempt | zero-byte `custom.dump` | Do not use. |
| `initial setup ref files for recovery` | Historical reference | Old `@workspace/db` package snapshot | Useful schema evidence, not imported by current app. |
| `.local` | Tooling/cache/templates | Skills/templates/local state | Not app source of truth. Contains many generic templates. |
| `.cursor` | Local planning/debug | Cursor plans and debug logs | Diagnostic only. May contain stale local debug output. |
| `.agents`, `.vscode` | Local tooling | Agent/editor config | Not runtime source. |
| `node_modules`, package-level `node_modules` | Generated dependencies | Installed packages | Never inspect as app truth except package availability. |

## Root Config Files

| File | Purpose | Trust Notes |
|---|---|---|
| `package.json` | Workspace scripts: build, start, typecheck | Runtime build/start source. |
| `pnpm-workspace.yaml` | Workspace package layout and dependency catalog | Current workspace truth. |
| `Dockerfile` | Railway build image | Current production backend build path. |
| `railway.json` | Railway deploy config | Current backend deploy config. |
| `vercel.json` | Root Vercel build/output config | Current frontend deployment config from repo root. |
| `middleware.js` | Root Vercel `/api/*` proxy to Railway | Critical when Vercel hosts frontend and Railway hosts API. |
| `.env.example` | Non-secret env template | Safe variable names and purpose. |
| `ScentCast.env` | Local env override | Do not print values. Used by API local bootstrap after `.env`. |
| `replit.md`, `.replit` | Old/Replit context | Historical/supporting only. |

## Files/Folders Not To Blindly Trust

- `dist/` folders: generated build output.
- `node_modules/`: dependency cache.
- `.local/`: generic skill/template content, not Scent Cast code.
- `.cursor/debug-db2024.log`: local debug evidence only.
- `supabase/.temp`: linked project metadata, not migrations.
- `initial setup ref files for recovery/dist`: generated declarations from the historical package.
- `supabase-clean-backup-20260506-115351`: zero-byte failed backup.


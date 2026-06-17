---
name: repo-map
description: Route work to the canonical ScentBeam package and avoid generated, backup, recovery, or build-output copies. Use at the start of unfamiliar tasks, when locating ownership, or before editing frontend, API, database, API contract, Beam agent, deployment, or image-pipeline code in this repository.
---

# Route work through the repository

Find the owning source tree before reading deeply or editing.

## Route by responsibility

| Concern                                          | Canonical source                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| React/Vite SPA, browser state, UI                | `artifacts/scent-cast/src/`                                           |
| Express routes, services, auth, image pipeline   | `artifacts/api-server/src/`                                           |
| Beam implementation, providers, MCP tools        | `artifacts/api-server/src/beam-agent/`                                |
| Beam runtime instructions and user-facing skills | `hermes-beam/`                                                        |
| Drizzle client and runtime schema                | `lib/db/src/`; exported schema starts at `lib/db/src/schema/index.ts` |
| OpenAPI contract                                 | `lib/api-spec/openapi.yaml`                                           |
| React Query and Zod generated clients            | `lib/api-client-react/src/generated/`, `lib/api-zod/src/generated/`   |
| Shared weather/mission scoring                   | `lib/scent-weather-engine/src/`                                       |
| Gemini integration                               | `lib/integrations-gemini-ai/src/`                                     |
| Operational utilities                            | `scripts/src/`                                                        |
| Vercel API proxy                                 | root `middleware.js` and `vercel.json`                                |
| Database migrations                              | `supabase/migrations/`                                                |

Treat `artifacts/mockup-sandbox/` as a playground unless the request explicitly targets it.

## Follow the important boundaries

- The SPA uses the local Express API for auth, wardrobe, images, and local profiles.
- `artifacts/scent-cast/src/lib/fragranceApi.ts` also calls an external Python fragrance engine through `VITE_FRAGRANCE_API_URL`. That engine is outside this repository. Do not invent or edit a local Python counterpart.
- Change `lib/api-spec/openapi.yaml`, then run code generation. Do not hand-edit generated client or Zod files.
- A schema file is not part of the runtime surface unless the relevant exports include it. Inspect `lib/db/src/schema/index.ts` and `lib/db/src/index.ts`.
- Beam has two layers: implementation under `artifacts/api-server/src/beam-agent/`; prompts, context, and presentation skills under `hermes-beam/`.

## Exclude noncanonical trees

Do not implement fixes in:

- any `dist/` or `dist-beam/` directory;
- `node_modules/`, `.image-cache/`, or `.local/`;
- `initial setup ref files for recovery/`;
- `supabase-clean-backup-*`;
- generated API clients unless regeneration produced the change;
- loose audit/handoff Markdown unless the task explicitly concerns that report.

Use `$token-efficient-navigation` before opening large files. Use `$dev-commands` and `$verify-without-regression` after locating the owner.

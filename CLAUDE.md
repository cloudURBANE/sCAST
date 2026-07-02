# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shared issue-fixing doctrine

For unfamiliar fixes, load `large-repo-investigation` and the focused skills it selects.

Do not edit immediately. First identify the user-visible symptom, likely route/page/component, state or data flow, styling/layout layer, and verification method. Trace route → component → state/hook → data layer → styling → tests/runtime, opening only files connected by repository evidence.

Before patching, summarize the canonical owner, caller/consumer, relevant state/data/style boundary, nearest verification target, and remaining uncertainty. Do not patch below 95% confidence in ownership; investigate further or ask for missing information.

Hard rules:

- Never guess ownership from names alone or invent files, functions, routes, or components.
- Never rewrite unrelated architecture or clean up unrelated code.
- Preserve current working behavior and visual language unless the issue requires changing them.
- Never change fonts, font stacks, letter spacing, design tokens, or global styling unless explicitly requested.
- Map UI symptoms to exact component/layout/style ownership before editing.
- For mobile UI bugs, inspect responsive classes, viewport constraints, overflow, sticky/fixed elements, and container sizing before changing logic.
- For conversation or agent bugs, prove where context is captured, transformed, lost, ignored, or overwritten.
- Prefer surgical patches. Do not introduce dependencies unless necessary and justified.
- Protect desktop, tablet, mobile, PWA, and existing feature behavior.
- Treat unrelated working-tree changes as user-owned and leave them untouched.
- Skip repetitive browser/device scenario suites unless the changed behavior specifically requires them.

Completion reports must state the exact fix, every file changed and why, commands run with outcomes, rendered verification when relevant, and remaining risks.

## Skills (load proactively)

`repo-map`, `token-efficient-navigation`, `dev-commands`, and
`verify-without-regression` are thin Claude adapters. Their canonical shared
instructions live under `.agents/skills/` so Codex and Claude cannot drift.
The large-repo investigation stack is mirrored in both agent trees with the same
core logic and tool-native references.

These live in `huge_monorepo/.claude/skills/` and load **only** when you launch Claude
from this repo (`huge_monorepo/`) — not from the workspace root or `search_engine/`.

| Skill                                | Use it when                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `large-repo-investigation`           | START of unfamiliar fixes — trace ownership, show evidence, patch minimally, and verify.                                     |
| `repo-navigation`                    | Locate route/component/state/data/style/test ownership without broad repository wandering.                                   |
| `visual-ui-debug`                    | Screenshots, visual complaints, responsive defects, clipping, overlap, or mobile/PWA UI bugs.                                |
| `state-agent-debug`                  | Conversation state, memory, context loss, hook/store/API flow, or agent-response failures.                                   |
| `safe-edit-verify`                   | After ownership is proven — make a surgical patch and run proportional checks.                                               |
| `commit-discipline`                  | After verification — isolate one logical task, commit only its files, and summarize why.                                     |
| `repo-map`                           | START of any task — deciding which file/service to touch; canonical trees vs mirror copies; giant files to never read whole. |
| `dev-commands`                       | Build, typecheck, test, or run the web app (pnpm) or Python engine. Windows node/pnpm bootstrap.                             |
| `git-guardrails`                     | Before any git merge/rebase/branch/push — short-lived branches, no back-merge of main.                                       |
| `cross-service-contract`             | Before editing `fragranceApi.ts`, the Python engine endpoints, or `source_coverage` / `derived_metrics` response shapes.     |
| `db-schema-safety`                   | Before any Drizzle schema / DB-touching change — what's in the runtime schema and how `push` works.                          |
| `fix-playbooks`                      | The recurring "couldn't find fragrance" selection error or "no image" / wrong-image pipeline bugs.                           |
| `verify-without-regression`          | The check routine before commit/push — typecheck, build, targeted tests, visual/behavior check.                              |
| `token-efficient-navigation`         | Locate a symbol then read only the slice — keep token use low in this large workspace.                                       |
| `skill-authoring`                    | Authoring/revising a skill so it matches house style AND actually loads.                                                     |
| `isolate-touch-interaction-gestures` | Touch/pointer gestures — tap-vs-scroll, swipe/drag, pointer capture in the SPA.                                              |
| `optimize-layout-for-device-class`   | Responsive layout/spacing across PC, iPad, iPhone, iPhone SE (320px).                                                        |
| `optimize-webkit-rendering-budget`   | Reduce WebKit/Safari GPU & compositor pressure (filters, blur, blend, layers).                                               |
| `unify-card-layouts-and-grids`       | Standardize card/grid alignment, equal heights, column spans across device classes.                                          |
| `no-projected-gold-glow`             | BEFORE adding/editing any box-shadow on a card/panel/dialog/button — forbids the gold projected glow that pools under surfaces (owner-rejected site-wide). |

**Cross-repo note:** the Python engine (`search_engine/`) has its OWN skill set
(`engine-live-verify`, `wardrobe-completeness-heal`) indexed in `search_engine/CLAUDE.md`.
Those load only from `search_engine/`, not here — launch Claude in the repo whose skills
you need. There is no shared/global skills dir; each repo manages its own. (Skills do NOT
load from the non-repo workspace root, so anything kept there is silently inert.)

## Commands

```bash
# Full typecheck across all packages
pnpm run typecheck

# Typecheck + build all packages
pnpm run build

# Run API server locally (builds then starts)
pnpm --filter @workspace/api-server run dev

# Run frontend SPA locally
pnpm --filter @workspace/scent-cast run dev

# Push DB schema changes (requires DATABASE_URL env var)
# GUARDED: refuses a non-local DATABASE_URL unless ALLOW_PROD_DB_PUSH=yes, because
# our DB may be a SHARED Supabase project holding another app's tables. push is
# also scoped to our own tables via tablesFilter (drizzle.config.ts), so foreign
# tables are never dropped. Deliberate prod push:
#   ALLOW_PROD_DB_PUSH=yes pnpm --filter @workspace/db run push   # bash
#   $env:ALLOW_PROD_DB_PUSH='yes'; pnpm --filter @workspace/db run push   # PowerShell
pnpm --filter @workspace/db run push

# Regenerate API React Query hooks and Zod schemas from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Run API server tests (Node built-in test runner, no framework)
pnpm --filter @workspace/api-server run test

# Run a single utility script
pnpm --filter @workspace/scripts run rebuild-user
pnpm --filter @workspace/scripts run verify:image-pipeline
```

**Package manager is pnpm only.** The `preinstall` hook rejects npm and yarn. Node >=20 required.

## Architecture

This is a pnpm monorepo. Workspace packages (per `pnpm-workspace.yaml`) come from `artifacts/*`, `lib/*`, `lib/integrations/*`, and `scripts`:

```
artifacts/
  scent-cast/        React 19 + Vite SPA (frontend) — @workspace/scent-cast
  api-server/        Express 5 REST API (backend)   — @workspace/api-server
  mockup-sandbox/    UI mockup playground (no production role)
lib/
  db/                Drizzle ORM schema + pg pool          — @workspace/db
  api-spec/          openapi.yaml + orval.config.ts        — @workspace/api-spec
  api-client-react/  Generated React Query hooks (Orval)   — @workspace/api-client-react
  api-zod/           Generated Zod schemas (Orval)         — @workspace/api-zod
  integrations-gemini-ai/  Gemini AI client                — @workspace/integrations-gemini-ai
  integrations/      Container for nested integration packages picked up by the
                     `lib/integrations/*` workspace glob (currently houses the
                     unpackaged `gemini_ai_integrations/` source tree, which is
                     not itself a workspace package — no `package.json`)
scripts/             One-off tsx utility scripts           — @workspace/scripts
```

### API codegen flow

`lib/api-spec/openapi.yaml` → Orval (config: `lib/api-spec/orval.config.ts`) → generates:

- `lib/api-client-react/src/generated/` — TanStack React Query hooks (`client: "react-query"`, `mode: "split"`, `baseUrl: "/api"`, custom `customFetch` mutator) consumed by the frontend
- `lib/api-zod/src/generated/` — Zod schemas (`client: "zod"`) consumed by the backend for request validation

The `codegen` script runs Orval and then `pnpm -w run typecheck:libs` (root-level `tsc --build`) automatically, so the lib packages are rebuilt as part of the same command. Just running `pnpm --filter @workspace/api-spec run codegen` is sufficient after changing the spec.

### Database

`lib/db` exports a `db` (Drizzle) instance and all schema tables. The `api-server` imports from `@workspace/db`. Schema tables exported via `lib/db/src/schema/index.ts`:

- `users` — Google-OAuth-linked accounts; opaque per-user UUID stored in `users.token` (no JWT)
- `user_fragrances` — per-user wardrobe/vault entries
- `global_fragrances` — shared catalog of processed fragrance profiles (avoids re-scraping)
- `image_cache` — processed image metadata: source URL hash, storage path, content hash, bg-removal status
- `user_settings`, `affiliate_links`

Note: `conversations.ts` and `messages.ts` exist on disk under `lib/db/src/schema/` but are **not** re-exported from `index.ts` and are not currently part of the runtime schema surface.

Drizzle config (`drizzle.config.ts`) declares its schema as the glob `./src/schema/*.ts`. The glob lives in the TS config (not the `package.json` script) so `drizzle-kit push` works on Windows shells that don't expand globs.

### Image pipeline (`artifacts/api-server/src/services/`)

Processing order for every fragrance image request:

1. `imagePipeline.ts:resolveProcessedFragranceImage` — entry point; checks lookup-key and search-query caches first
2. `serperService.ts` — searches Serper.dev for candidate image URLs (or uses a manually supplied URL)
3. `bgService.ts` / `bgServiceCore.ts` — calls Poof API for background removal; validates that the result is not fully transparent
4. `sharp` — resizes to 768×768 max, encodes to WebP
5. `imageObjectStorage.ts` — uploads to Firebase Storage, Supabase Storage, or local `.image-cache/` (dev only)
6. `imageCacheService.ts` — writes a row to `image_cache` with source hash, content hash, storage path, and bg-removal status

In-flight deduplication is handled by a `Map<string, Promise>` keyed on `` `${sourceUrlHash}:${removeBackground ? "1" : "0"}` `` so concurrent requests for the same image (with the same bg-removal flag) don't double-process.

### Scent engine (`artifacts/api-server/src/services/scentEngine.ts`)

`buildProfile(name, brand, fallback?)` orchestration:

1. Look up `global_fragrances` (exact `lookup_key`, then fuzzy `searchCatalog`; fuzzy can be disabled via `opts.allowCatalogFuzzy: false`)
2. Resolve image through the pipeline above (search-query first, then `fallback.imageUrl` if provided)
3. Match local fragrance dataset via `findDatasetFragrance` (note: Wikipedia scraping in `fallbackIntelligence.ts` is **not** invoked from here — callers in `routes/scent.ts` may scrape upstream and pass the result in via `fallback`)
4. Parse + vectorize into a 6-axis scent vector (`freshness`, `sweetness`, `woodiness`, `spice`, `warmth`, `musk`) via `scentVectorizer.ts`
5. Compute performance metrics and context profile, then save the assembled profile back to `global_fragrances` (best-effort; failures are non-fatal)

### External fragrance engine (third tier, outside this monorepo)

The SPA does **not** get Fragrantica / Basenotes data from the Express API in this repo. Search and detail lookups go to a separate Python service at `VITE_FRAGRANCE_API_URL` (source lives under `search_engine/fragrance_parser_full_rewrite_fixed.py` in the parent workspace, not in this monorepo). Three endpoints are consumed by `artifacts/scent-cast/src/lib/fragranceApi.ts`:

- `GET  /api/fragrances/search?q=…` — primary search; results carry `origin: "srt"`
- `POST /api/fragrances/details` — detail body; the SPA reads `source_coverage`, `derived_metrics`, and `enrichment` off this response
- `POST /api/fragrances/details/requeue` — manual re-scrape trigger

When `payload.origin === "app"` or the id starts with `catalog:` / `dataset:` / `local:`, `getFragranceDetails` routes to the local Express API instead (`/api/fragrances/details`, mounted by `routes/fragrances.ts`). All other detail fetches go to the external Python engine.

**`source_coverage` contract** (set by the Python engine, enforced by the SPA in `lib/fragranceApi.ts:isSourceCoverageComplete`): a detail is considered "complete" only when `basenotes === true && fragrantica === true && (complete === true || fragrantica_metrics_complete === true || derived_metrics === "complete"|"completed"|"full")`. The SPA gates spinners and "partial details" notices on this predicate — keep the engine's response shape stable. Note: the engine's `complete` flag is honest about metric completeness — it is only `true` when Fragrantica's 4 status-metric groups have all arrived (`fg_complete`) or the detail is Parfinity-backed, so it agrees with `derived_metrics === "full"` and `fragrantica_metrics_complete`; do not loosen it back to "any FG card present" or the SPA self-heal loop will stop refreshing genuinely-partial tiles.

### Enrichment queue (Pass 1 scaffolding only)

`artifacts/api-server/src/services/enrichmentQueue*.ts` and `routes/enrichment.ts` implement a job-queue foundation (DB-backed `enrichment_jobs` table, idempotent upsert by canonicalized `fg_url`, status lookup endpoint at `GET /api/enrichment/status`). The producer (`routes/fragrances.ts` → `enqueueEnrichmentJob`) and the consumer (`index.ts` → `startEnrichmentWorker` / `startEnrichmentFailedJobRetrySweeper`) **are both wired, but each is gated behind an env flag that defaults OFF** — `ENRICHMENT_QUEUE_ENABLED` (`enrichmentQueueProducerEnabled()`) guards the enqueue, `ENRICHMENT_WORKER_ENABLED` (`enrichmentWorkerEnabled()`) guards the worker. So in a default deploy nothing enqueues and nothing consumes, and the system is inert — but flipping either flag activates that half. Treat this as opt-in scaffolding, not dead code. The `GET /api/enrichment/status` endpoint is always wired and returns `{ status: "not_found" }` until a producer is enabled.

### Frontend scoring (`artifacts/scent-cast/src/lib/scentWeatherEngine.ts`)

Pure client-side; no API call. `calculateScentWeatherRecommendation(input)` takes weather + setting + fragrance profile and returns a recommendation with `confidence`, `projection_risk`, `wear_window`, `spray_count`, and family lists. `App.tsx` scores every wardrobe item and surfaces the highest-scoring one.

### Deployment topology

| Environment | Frontend                                                    | Backend                |
| ----------- | ----------------------------------------------------------- | ---------------------- |
| Production  | Vercel SPA                                                  | Railway Express server |
| Self-hosted | Express serves `artifacts/scent-cast/dist/public` as static | Same Express process   |

The root `middleware.js` is a Vercel Edge middleware (matcher `/api/:path*`) that buffers the request body and proxies `/api/*` to `BACKEND_ORIGIN` (the Railway URL); when `BACKEND_ORIGIN` is unset it returns a 503 with a configuration message. In self-hosted mode `app.ts` checks `frontendStaticDir` (= `artifacts/scent-cast/dist/public`) at startup; if present it mounts `express.static` and a GET/HEAD fallthrough to `index.html` for SPA routing.

### Auth

Google OAuth flow: `GET /api/auth/google` → Google consent → `GET /api/auth/google/callback`. The callback exchanges the code, looks up or creates a `users` row (matched by `oauth_subject` then `email`), and redirects back to the SPA with `?oauth_token=<users.token>&oauth_email=<email>`. The token is **not** a JWT — it's an opaque per-user `uuid` stored in `users.token` (auto-generated via `defaultRandom()`). The SPA reads it from the redirect query and persists it in `localStorage` under `scent_token` (key defined in `App.tsx` as `STORAGE_KEYS.TOKEN`). Protected API routes expect `Authorization: Bearer <users.token>` and look the user up directly by token.

Ops-only wardrobe rebuild: `POST /api/admin/wardrobe/rebuild` (`routes/admin.ts`) accepts `{ email }` and `x-admin-secret` matching `ADMIN_SECRET`; it never returns bearer tokens or creates users. The `rebuild-user` script uses this route.

## Environment variables

Copy `.env.example` to `.env`. Minimum for local dev (backend):

```
DATABASE_URL=postgresql://...
NODE_ENV=development
PORT=3000
IMAGE_ALLOW_LOCAL_OBJECT_STORAGE=true   # enables .image-cache/ as storage backend
```

Required frontend env (defined in `artifacts/scent-cast/.env.local` or root `ScentCast.env`; consumed by Vite — without `VITE_FRAGRANCE_API_URL` the SPA throws on every search/detail call from `lib/fragranceApi.ts:getFragranceEngineApiBase`):

```
VITE_FRAGRANCE_API_URL=<external Python fragrance engine base URL>
VITE_API_BASE_URL=<optional override for the Express API base; defaults to same-origin>
```

Optional backend integrations (all degrade gracefully when absent): `WEATHER_API_KEY`, `SERPER_API_KEY`, `REMOVE_BG_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`/`SECRET`, Firebase Storage vars, Supabase Storage vars, Rakuten/Amazon affiliate vars.

## TypeScript project setup

`tsconfig.base.json` at root defines shared compiler options. Each lib package is a composite project with its own `tsconfig.json` referencing the base. `pnpm run typecheck:libs` runs `tsc --build` at the root (project references), and `pnpm run typecheck` additionally typechecks all artifact and script packages with `--if-present`.

## pnpm workspace catalog

Shared dependency versions are pinned in `pnpm-workspace.yaml` under `catalog:`. Reference them in `package.json` with `catalog:` instead of a version range. `minimumReleaseAge: 1440` (1 day) is enforced for supply-chain safety — do not disable it.

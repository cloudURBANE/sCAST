# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### Scent Cast (`artifacts/scent-cast`)
- **Kind**: React + Vite SPA at `/`
- **Port**: 18716
- **Description**: Premium fragrance intelligence platform with search-powered scent identification, weather-based recommendations, and a personal fragrance vault.

**Frontend components:**
- `LavaBackground.tsx` — WebGL GLSL shader for animated crack lighting effect
- `WeatherWidget.tsx` — Live weather display with Three.js/R3F icosahedron visualization
- `FragranceCapture.tsx` — Search-first fragrance capture widget
- `Wardrobe.tsx` — Personal fragrance vault with 3D shelf display and detail modal
- `ScentIntentModal.tsx` — 2-step destination + energy state intent matching flow
- `ScentNotesInfographic.tsx` — Interactive SVG olfactory pyramid infographic
- `chat/ChatInterface.tsx` — Nexus chat UI

**Key dependencies:** `three`, `@react-three/fiber`, `framer-motion`, `axios`

### API Server (`artifacts/api-server`)
- **Kind**: Express 5 REST API at `/api`
- **Port**: auto-assigned

**API Routes (`/api/`):**
- `GET /weather` — Live weather via OpenWeatherMap (or demo fallback)
- `POST /scent-profile` — Build full fragrance intelligence profile (vectorize + image search + bg removal)
- `POST /search-scent` — Search local dataset + Wikipedia fallback

**Services:**
- `weatherService.ts` — OpenWeatherMap (3.0 + 2.5 fallback)
- `imageService.ts` — Serper image search
- `bgService.ts` — Poof API + sharp normalization
- `scentEngine.ts` — Core orchestrator for profile building
- `scentParser.ts` — Parse fragrance data
- `scentVectorizer.ts` — Compute 6-axis scent vector + performance + context
- `datasetLoader.ts` — Static JSON dataset loader (fragrances.json, ~3.9KB)
- `fallbackIntelligence.ts` — Wikipedia scraper for unknown fragrances

**Key dependencies:** `axios`, `sharp`, `cheerio`, `form-data`

## Environment Variables (Optional)
- `WEATHER_API_KEY` — OpenWeatherMap API key for live weather data
- `SERPER_API_KEY` (+ optional `SERPER_IMAGE_API_URL`) — Serper image search for fragrance images
- `REMOVE_BG_API_KEY` — Poof API key for background removal from bottle images

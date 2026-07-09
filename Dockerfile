# syntax=docker/dockerfile:1
# Railway / Docker: build the monorepo API without ARG/ENV for secrets.
# Set sensitive variables in Railway → Variables (runtime), not in the Dockerfile.
#
# Three stages (production-readiness G1):
#   base    — shared node+pnpm toolchain
#   build   — full workspace install (dev deps included), typecheck + all
#             package builds, then `pnpm deploy` prunes @workspace/api-server
#             down to a self-contained prod-only package (its dependencies are
#             ALL esbuild bundles into `dist/index.mjs` / `dist-beam/beam-mcp.mjs`
#             except the externals below, so the pruned node_modules only needs
#             to carry those — sharp, ioredis, firebase-admin, etc.)
#   runtime — the pruned package + the built SPA static assets, non-root.
#
# Directory nesting in the runtime stage deliberately mirrors the source tree
# (artifacts/api-server/, artifacts/scent-cast/dist/public, lib/db/migrations)
# rather than flattening to /app: src/paths.ts (frontendStaticDir) and the
# RUN_MIGRATIONS_ON_BOOT resolution in src/index.ts both derive their target
# from the bundled dist/index.mjs's OWN location by walking a fixed number of
# parent directories, not from an env var or cwd. Preserving the nesting means
# neither needed a runtime-detection rewrite for this Dockerfile change.
FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

# Install devDependencies (TypeScript, Vite, etc.) required by root `pnpm run build`.
RUN NODE_ENV=development CI=true pnpm install --frozen-lockfile

# Typecheck + workspace builds; production mode for app bundles where applicable.
# Produces artifacts/api-server/dist (API) and artifacts/scent-cast/dist/public (SPA).
RUN NODE_ENV=production pnpm run build

# Bundle the Beam MCP server (dist-beam/beam-mcp.mjs). Isolated from the main
# build (build-beam-mcp.mjs never touches dist/), so it cannot affect the API
# bundle. A SEPARATE Railway service runs the MCP listener from this same
# image via `pnpm run start:beam-mcp` — see the runtime-stage note below.
RUN NODE_ENV=production pnpm --filter @workspace/api-server run beam:mcp:build

# Prune @workspace/api-server to a self-contained, production-only package:
# its own package.json/dist/dist-beam plus ONLY the node_modules its bundles
# actually need at runtime (the esbuild `external` list — sharp, ioredis,
# firebase-admin, etc. — everything else is already inlined into the bundles).
# Run AFTER both builds above so dist/ and dist-beam/ are carried into the
# deployed output (`pnpm deploy` copies the package directory as it stands).
RUN pnpm --filter @workspace/api-server deploy --prod /out/api-server

# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /app/artifacts/api-server

COPY --from=build --chown=node:node /out/api-server ./
COPY --from=build --chown=node:node /app/artifacts/scent-cast/dist/public /app/artifacts/scent-cast/dist/public
COPY --from=build --chown=node:node /app/lib/db/migrations /app/lib/db/migrations

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

# Container liveness probe. Uses Node (always present) rather than wget/curl,
# which aren't guaranteed in bookworm-slim. Hits the dependency-free /api/healthz
# liveness route so a transient DB blip never trips a restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Default command = the Express API only (unchanged behavior). The Beam MCP
# listener runs as a SEPARATE Railway service from this same image with an
# overridden start command.
#
# BREAKING for that second service's Railway config: the pruned runtime image
# has no pnpm-workspace.yaml (WORKDIR IS the api-server package now, not the
# repo root), so a `--filter @workspace/api-server` invocation can no longer
# resolve. The override must change from
#   pnpm --filter @workspace/api-server run start:beam-mcp
# to
#   pnpm run start:beam-mcp
# This is a one-time operator step in the Railway dashboard for that service —
# see docs/USER_LAUNCH_SETUP.md.
CMD ["pnpm", "start"]

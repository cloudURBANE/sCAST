# syntax=docker/dockerfile:1
# Multi-stage build for the ScentCast monorepo API (production-readiness G1).
# - build stage: full install + typecheck + bundle (esbuild) both the API and
#   the Beam MCP entrypoint, plus the Vite SPA static output.
# - runtime stage: prod-deps-only, non-root, healthchecked. The API is a single
#   bundled dist/index.mjs (esbuild inlines the workspace packages), so runtime
#   node_modules only needs the packages esbuild left external (sharp,
#   firebase-admin, ioredis, ...). We build once then `pnpm prune --prod` in
#   place and copy the result — robust against the pnpm workspace-protocol graph
#   (the plan's sanctioned fallback to a fiddly `pnpm deploy`).
# Secrets are NEVER baked in — set them in Railway → Variables at runtime.

############################  base  ############################
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

############################  build  ############################
FROM base AS build

# Manifests first so the dependency layer caches across source-only changes.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

# devDependencies (TypeScript, Vite, esbuild, ...) are needed for the build.
RUN NODE_ENV=development CI=true pnpm install --frozen-lockfile

# Build-time SPA version tag (a git SHA, not a secret): webVitalsTelemetry.ts
# reads VITE_GIT_SHA when Vercel's injected VITE_VERCEL_GIT_COMMIT_SHA is
# absent. Empty default keeps builds without the arg byte-identical to before.
ARG VITE_GIT_SHA=""
ENV VITE_GIT_SHA=${VITE_GIT_SHA}

# Vite replaces this public client key while building the SPA. Railway only
# exposes service variables to Dockerfile builds when the argument is declared.
ARG VITE_SENTRY_DSN=""

# Typecheck + workspace builds (API bundle + SPA static output).
RUN NODE_ENV=production pnpm run build

# Bundle the Beam MCP entrypoint into dist-beam/beam-mcp.mjs. Isolated from the
# API bundle (build-beam-mcp.mjs never touches dist/), so a SEPARATE Railway
# service can run `start:beam-mcp` from this same image.
RUN NODE_ENV=production pnpm --filter @workspace/api-server run beam:mcp:build

# Strip devDependencies in place. Everything the runtime imports is either in
# the esbuild bundle or an external prod dependency (sharp/firebase-admin/...);
# dropping dev deps removes the bulk of the image (typescript, vite, esbuild,
# tailwind, ...).
RUN pnpm prune --prod

############################  runtime  ############################
FROM base AS runtime

# TLS roots for outbound HTTPS (Serper, Poof, Supabase, OAuth, engine, ...).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

# Copy the pruned workspace: prod-only node_modules, the bundled API (dist/) and
# Beam MCP (dist-beam/), the SPA static output for self-hosted serving, the
# migration SQL read at runtime by RUN_MIGRATIONS_ON_BOOT, and the manifests
# that make `pnpm --filter` resolve. Owned by root but world-readable; `node`
# only ever reads them (production writes go to object storage, never disk).
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/api-server/dist-beam ./artifacts/api-server/dist-beam
COPY --from=build /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=build /app/artifacts/scent-cast/dist/public ./artifacts/scent-cast/dist/public
COPY --from=build /app/lib/db/package.json ./lib/db/package.json
COPY --from=build /app/lib/db/migrations ./lib/db/migrations

# Drop root: run as the built-in unprivileged `node` user.
USER node

EXPOSE 8080

# Container liveness probe. Node (always present) over wget/curl (absent in
# slim). Hits the dependency-free /api/healthz so a transient DB blip never
# trips a restart. Railway itself gates deploys on /api/readyz (railway.json).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Default = the Express API. The Beam MCP listener runs as a SEPARATE Railway
# service from this same image with an overridden start command:
# `pnpm --filter @workspace/api-server run start:beam-mcp`.
CMD ["pnpm", "start"]

# syntax=docker/dockerfile:1
# Railway / Docker: build the monorepo API without ARG/ENV for secrets.
# Set sensitive variables in Railway → Variables (runtime), not in the Dockerfile.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY scripts ./scripts

# Install devDependencies (TypeScript, Vite, etc.) required by root `pnpm run build`.
RUN NODE_ENV=development CI=true pnpm install --frozen-lockfile

# Typecheck + workspace builds; production mode for app bundles where applicable.
RUN NODE_ENV=production pnpm run build

# Also bundle the Beam MCP server (dist-beam/beam-mcp.mjs). This build is isolated
# from the main one (build-beam-mcp.mjs never touches dist/), so it cannot affect
# the API bundle. Baking it in lets a SEPARATE Railway service run the MCP listener
# from this same image via `start:beam-mcp`; the API service below is unchanged.
RUN NODE_ENV=production pnpm --filter @workspace/api-server run beam:mcp:build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Default command = the Express API only (unchanged). The Beam MCP listener runs
# as a SEPARATE Railway service from this same image with an overridden start
# command: `pnpm --filter @workspace/api-server run start:beam-mcp` (binds
# BEAM_MCP_HOST/BEAM_MCP_PORT, default :8848). See
# docs/beam-agent/16-hermes-017-railway-standup.md.
CMD ["pnpm", "start"]

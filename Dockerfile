# syntax=docker/dockerfile:1
# Railway / Docker: build the monorepo API without ARG/ENV for secrets.
# Set sensitive variables in Railway → Variables (runtime), not in the Dockerfile.
FROM node:20-bookworm-slim

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

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["pnpm", "start"]

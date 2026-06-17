---
name: dev-commands
description: Select accurate pnpm commands for installing, typechecking, testing, building, running, generating API clients, operating Beam MCP, or working with Drizzle in the ScentBeam monorepo on Windows. Use before running repository commands or when choosing the smallest command that covers the changed package.
---

# Run repository commands accurately

Run commands from the repository root unless stated otherwise. Use `corepack pnpm`; never use npm or yarn. The root pins pnpm 9.15.9 and requires Node 22.6 or newer.

## Bootstrap on Windows

```powershell
$env:Path += ';C:\Program Files\nodejs'
corepack enable
corepack pnpm install
```

Do not reinstall dependencies unless dependency state is actually missing or stale.

## Choose the smallest package command

```powershell
# Frontend
corepack pnpm --filter @workspace/scent-cast run typecheck
corepack pnpm --filter @workspace/scent-cast run test
corepack pnpm --filter @workspace/scent-cast run build
corepack pnpm --filter @workspace/scent-cast run dev

# Express API and Beam implementation
corepack pnpm --filter @workspace/api-server run typecheck
corepack pnpm --filter @workspace/api-server run test
corepack pnpm --filter @workspace/api-server run build
corepack pnpm --filter @workspace/api-server run beam:mcp:build

# Shared scoring library
corepack pnpm --filter @workspace/scent-weather-engine run test

# Utility scripts
corepack pnpm --filter @workspace/scripts run typecheck
corepack pnpm --filter @workspace/scripts run <script-name>
```

The API package `dev` script uses POSIX `export` and may fail in native PowerShell. Prefer building and starting it explicitly:

```powershell
$env:NODE_ENV='development'
corepack pnpm --filter @workspace/api-server run build
corepack pnpm --filter @workspace/api-server run start
```

## Run repository-wide gates only when scope requires them

```powershell
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run build
```

## Preserve generated and database safety

After changing `lib/api-spec/openapi.yaml`:

```powershell
corepack pnpm --filter @workspace/api-spec run codegen
```

Do not hand-edit generated clients. Treat database pushes as state-changing operations. `@workspace/db` runs a preflight, but still inspect the target `DATABASE_URL`; never run `push-force` as routine verification.

Use `$verify-without-regression` to choose the final gate set.

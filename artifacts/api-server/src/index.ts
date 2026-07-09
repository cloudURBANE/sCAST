// Must run before `./app` — ES modules evaluate imports before other statements,
// so dotenv side effects live in this dependency-free module.
import "./env-bootstrap";
// Must run before `@workspace/db` (imported below): validates required vars
// with a structured fatal message before that package's own bare `throw` on
// a missing DATABASE_URL would otherwise fire first.
import "./env-validate";
import type { Server } from "node:http";
import path from "node:path";
import sharp from "sharp";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import {
  startEnrichmentFailedJobRetrySweeper,
  startEnrichmentWorker,
  stopEnrichmentFailedJobRetrySweeper,
  stopEnrichmentWorker,
} from "./services/enrichmentQueue";
import { enrichJobViaEngine } from "./services/enrichmentProcessor";
import { ensureTenantBaseline } from "./services/tenants";
import { getSerperPool } from "./services/serperService";
import { getRemoveBgPool } from "./services/bgService";
import { announceRedisMode, getRedis, isRedisConfigured } from "./lib/redisClient";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start() {
  // Cap libvips' worker-thread pool. sharp/libvips otherwise default `concurrency`
  // to the host core count and spins that many threads per in-flight image op; on a
  // small shared web dyno several concurrent fragrance-image builds oversubscribe the
  // cores and raise event-loop latency for *all* routes (including cheap JSON ones).
  // `cache({ files: 0 })` disables the on-disk operation cache (we only process
  // in-memory buffers, so it buys nothing and just holds file descriptors).
  const sharpConcurrencyRaw = Number(process.env["SHARP_CONCURRENCY"]);
  const sharpConcurrency =
    Number.isFinite(sharpConcurrencyRaw) && sharpConcurrencyRaw >= 0
      ? Math.floor(sharpConcurrencyRaw)
      : 2;
  sharp.concurrency(sharpConcurrency);
  sharp.cache({ files: 0 });
  logger.info({ sharpConcurrency: sharp.concurrency() }, "sharp/libvips concurrency capped");

  // Build the API-key pools at boot (env is already loaded) so their health is
  // visible on GET /api/admin/key-pools before the first image request. Done
  // here rather than at module load so offline scripts (e.g. verify:poof-paths)
  // that set stub keys after importing the service still read fresh env.
  const serperKeys = getSerperPool().size;
  const removeBgKeys = getRemoveBgPool().size;
  logger.info({ serperKeys, removeBgKeys }, "API key pools initialized");

  // Announce shared-state durability at boot so an unset REDIS_URL (ephemeral
  // Beam conversation memory + rate limits) is visible in the logs instead of
  // silent. When configured, eagerly warm the connection so the ready/error
  // outcome is logged at boot rather than racing the first request.
  announceRedisMode();
  if (isRedisConfigured()) void getRedis();

  // Versioned migrations as a deploy step (production-readiness E1). Opt-in via
  // RUN_MIGRATIONS_ON_BOOT=true so platforms without a release phase (Railway)
  // apply pending lib/db/migrations/ before traffic cutover. Boot-time is safe
  // while numReplicas=1 (railway.json) — no concurrent migrators; revisit with
  // a release-phase job or advisory lock before scaling out. A migration
  // failure refuses to serve: wrong-schema traffic is worse than a failed
  // deploy, and the readiness probe keeps the previous instance in rotation.
  if (process.env["RUN_MIGRATIONS_ON_BOOT"] === "true") {
    try {
      // Not cwd-relative: `pnpm --filter @workspace/api-server run start` (and
      // Railway's `pnpm start`) run with cwd = artifacts/api-server, not the
      // repo root, so a cwd-relative guess breaks. esbuild bundles this file to
      // artifacts/api-server/dist/index.mjs, so import.meta.dirname is stable
      // there regardless of invocation cwd; walk up three levels (dist →
      // api-server → artifacts → repo root) to lib/db/migrations.
      const migrationsFolder =
        process.env["MIGRATIONS_DIR"] ??
        path.resolve(import.meta.dirname, "../../../lib/db/migrations");
      const before = Date.now();
      await migrate(db, { migrationsFolder });
      logger.info(
        { migrationsFolder, ms: Date.now() - before },
        "Database migrations up to date",
      );
    } catch (err) {
      logger.error({ err }, "Migration run failed; refusing to serve");
      process.exit(1);
    }
  }

  // Self-heal the tenant baseline before serving: create the default tenant and
  // backfill any pre-tenant rows. This removes the need to hand-run a migration
  // in a precise order — the app converges every boot.
  try {
    await ensureTenantBaseline();
  } catch (err) {
    logger.error({ err }, "Failed to ensure tenant baseline; refusing to serve");
    process.exit(1);
  }

  const server = app.listen(port, "0.0.0.0", (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startEnrichmentFailedJobRetrySweeper();
    // Consumer for the enrichment queue. No-op unless ENRICHMENT_WORKER_ENABLED
    // is set, so it stays dormant until enrichment is deliberately turned on.
    startEnrichmentWorker(enrichJobViaEngine);
  });

  // Keep the server's keep-alive window wider than the upstream proxy idle
  // timeout (Railway/Vercel ~60s). With Node's 5s default, the server can close
  // a pooled connection mid-flight just as the proxy reuses it, surfacing as
  // sporadic 502s. headersTimeout must exceed keepAliveTimeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  installGracefulShutdown(server);
}

// How long to wait for in-flight requests to drain before forcing exit. Kept
// under a typical platform SIGKILL grace window (~30s on Railway) so we always
// exit on our own terms with the pool closed rather than being hard-killed.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

/**
 * Drain gracefully on SIGTERM/SIGINT: stop the background workers, stop
 * accepting new connections, let in-flight requests finish, close the pg pool,
 * then exit. A watchdog forces exit if draining stalls. Without this, every
 * Railway redeploy hard-kills in-flight requests (502/ECONNRESET) and can sever
 * an enrichment job mid-write.
 */
function installGracefulShutdown(server: Server): void {
  const drainPoolAndExit = (code: number, watchdog: NodeJS.Timeout): void => {
    pool
      .end()
      .then(() => {
        logger.info("Drained cleanly; exiting");
        clearTimeout(watchdog);
        process.exit(code);
      })
      .catch((poolErr) => {
        logger.error({ err: poolErr }, "Error closing database pool");
        clearTimeout(watchdog);
        process.exit(1);
      });
  };

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Received shutdown signal; draining");

    const watchdog = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Drain timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();

    stopEnrichmentWorker();
    stopEnrichmentFailedJobRetrySweeper();

    server.close((err) => {
      if (err) logger.error({ err }, "Error while closing HTTP server");
      drainPoolAndExit(err ? 1 : 0, watchdog);
    });
    // Release idle keep-alive sockets so `server.close` doesn't wait out the 65s
    // keepAliveTimeout on connections that aren't mid-request; active requests
    // are left to finish.
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Last-resort handlers so an unhandled rejection or thrown error is logged as a
  // structured pino line (not just Node's default stderr trace) before the
  // process exits. ON_FAILURE restart policy brings it back; this preserves the
  // evidence. Exit so we never keep serving from an unknown/corrupt state.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException; exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandledRejection; exiting");
    process.exit(1);
  });
}

void start();

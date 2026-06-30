// Must run before `./app` — ES modules evaluate imports before other statements,
// so dotenv side effects live in this dependency-free module.
import "./env-bootstrap";
import sharp from "sharp";
import app from "./app";
import { logger } from "./lib/logger";
import { startEnrichmentFailedJobRetrySweeper, startEnrichmentWorker } from "./services/enrichmentQueue";
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
}

void start();

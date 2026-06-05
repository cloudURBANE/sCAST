// Must run before `./app` — ES modules evaluate imports before other statements,
// so dotenv side effects live in this dependency-free module.
import "./env-bootstrap";
import app from "./app";
import { logger } from "./lib/logger";
import { startEnrichmentFailedJobRetrySweeper } from "./services/enrichmentQueue";
import { ensureTenantBaseline } from "./services/tenants";
import { getSerperPool } from "./services/serperService";
import { getRemoveBgPool } from "./services/bgService";

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
  // Build the API-key pools at boot (env is already loaded) so their health is
  // visible on GET /api/admin/key-pools before the first image request. Done
  // here rather than at module load so offline scripts (e.g. verify:poof-paths)
  // that set stub keys after importing the service still read fresh env.
  const serperKeys = getSerperPool().size;
  const removeBgKeys = getRemoveBgPool().size;
  logger.info({ serperKeys, removeBgKeys }, "API key pools initialized");

  // Self-heal the tenant baseline before serving: create the default tenant and
  // backfill any pre-tenant rows. This removes the need to hand-run a migration
  // in a precise order — the app converges every boot.
  try {
    await ensureTenantBaseline();
  } catch (err) {
    logger.error({ err }, "Failed to ensure tenant baseline; refusing to serve");
    process.exit(1);
  }

  app.listen(port, "0.0.0.0", (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startEnrichmentFailedJobRetrySweeper();
  });
}

void start();

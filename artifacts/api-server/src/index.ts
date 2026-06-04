// Must run before `./app` — ES modules evaluate imports before other statements,
// so dotenv side effects live in this dependency-free module.
import "./env-bootstrap";
import app from "./app";
import { logger } from "./lib/logger";
import { startEnrichmentFailedJobRetrySweeper } from "./services/enrichmentQueue";
import { ensureTenantBaseline } from "./services/tenants";

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

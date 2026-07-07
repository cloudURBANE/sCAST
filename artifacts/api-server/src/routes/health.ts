import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { getRedis, isRedisConfigured } from "../lib/redisClient.ts";
import { logger } from "../lib/logger.ts";

const router: IRouter = Router();

// Liveness: proves the event loop is alive and the process is serving. Touches
// no external dependency on purpose, so a transient DB/Redis blip never trips a
// container restart. Used by the Docker HEALTHCHECK.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

const READY_TIMEOUT_MS = 3_000;

/**
 * Race a promise against a timeout. The original promise ALWAYS gets a rejection
 * handler attached (`.catch`) so that, when the timeout wins, a later rejection
 * of the loser can't surface as an unhandledRejection — which the process-level
 * handler (index.ts) would treat as fatal.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => {});
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Readiness: the instance can actually serve. The database is the one hard
// dependency, so a failed `SELECT 1` returns 503. Redis is optional (rate limits
// and Beam session memory degrade gracefully when it's absent), so its status is
// reported but never fails the check. Gates Railway deploys (railway.json
// healthcheckPath) so a misconfigured build never receives traffic; also the
// endpoint for external uptime monitoring.
router.get("/readyz", async (_req, res) => {
  const checks: {
    db: "ok" | "error";
    redis: "ok" | "error" | "not_configured";
  } = { db: "error", redis: "not_configured" };

  try {
    await withTimeout(pool.query("SELECT 1"), READY_TIMEOUT_MS, "database readiness");
    checks.db = "ok";
  } catch (err) {
    logger.error({ err }, "readiness: database check failed");
  }

  if (isRedisConfigured()) {
    try {
      const client = await withTimeout(getRedis(), READY_TIMEOUT_MS, "redis connect");
      if (!client) throw new Error("redis client unavailable");
      await withTimeout(client.get("readyz:ping"), READY_TIMEOUT_MS, "redis ping");
      checks.redis = "ok";
    } catch (err) {
      checks.redis = "error";
      logger.warn({ err }, "readiness: redis check failed (non-fatal; degrades gracefully)");
    }
  }

  const ready = checks.db === "ok";
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});

export default router;

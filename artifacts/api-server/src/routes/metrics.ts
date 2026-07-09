// Server side of the client's existing web-vitals beacon
// (artifacts/scent-cast/src/lib/webVitalsTelemetry.ts), which already sends a
// well-formed WebVitalMetric payload to VITE_WEB_VITALS_URL whenever that env
// var is set — it has just had nowhere to send it. This route gives it a
// same-origin target: set VITE_WEB_VITALS_URL=/api/metrics/vitals at SPA
// build time. Cheapest possible real option per production-readiness D1: log
// a structured pino line and let Railway log search be the query surface;
// revisit a real metrics store only once there's a question logs can't answer.
import express, { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger.ts";
import { rateLimitMiddleware } from "../lib/rateLimit.ts";

const router: IRouter = Router();

// Tight cap: a vitals beacon is a few dozen fields of numbers/short strings,
// nowhere near the app-wide 256kb default — this is an unauthenticated,
// public endpoint, so keep its blast radius small on purpose.
const VITALS_BODY_LIMIT = "2kb";

const vitalsRateLimit = rateLimitMiddleware({
  name: "metrics-vitals",
  // Generous: every real pageview can fire up to 4 metrics (CLS/FCP/INP/LCP).
  // This only needs to stop abuse, not throttle legitimate traffic.
  limit: 600,
  windowMs: 5 * 60_000,
});

const webVitalMetricSchema = z.object({
  route: z.string().max(512),
  appVersion: z.string().max(128).optional(),
  deviceClass: z.enum(["mobile", "tablet", "desktop"]),
  connectionType: z.string().max(64).optional(),
  authState: z.enum(["authenticated", "guest"]),
  vaultSizeBucket: z.enum(["0", "1-2", "3-9", "10-24", "25-49", "50+"]),
  name: z.string().max(32),
  value: z.number(),
  rating: z.string().max(32),
  delta: z.number(),
  id: z.string().max(128),
  navigationType: z.string().max(64).optional(),
  timestamp: z.number(),
});

router.post(
  "/metrics/vitals",
  // navigator.sendBeacon posts a Blob without a fetch-style Content-Type
  // override in older browsers, so accept both application/json (explicit
  // Blob type set by the client today) and the beacon default text/plain.
  express.json({ limit: VITALS_BODY_LIMIT, type: ["application/json", "text/plain"] }),
  vitalsRateLimit,
  (req, res) => {
    // Always 204: this is a fire-and-forget navigator.sendBeacon() call with
    // no client-side error handling to react to a 4xx anyway.
    const parsed = webVitalMetricSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "web-vital: malformed payload, dropped");
    } else {
      logger.info({ vital: parsed.data }, "web-vital");
    }
    res.status(204).end();
  },
);

export default router;

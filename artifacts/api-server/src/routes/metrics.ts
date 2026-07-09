import { Router, type IRouter, type Request, type Response } from "express";
import { rateLimitMiddleware } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Client-telemetry sink (production-readiness D1). The SPA's Web-Vitals and
// image-load beacons existed but pointed nowhere; these endpoints turn Railway
// log search into the query surface — a real metrics store is deliberately
// deferred until the logs can't answer a question. Point the SPA here at build
// time: VITE_WEB_VITALS_URL=/api/metrics/vitals,
// VITE_IMAGE_METRICS_URL=/api/metrics/images.
//
// Unauthenticated by design (beacons fire for signed-out users too), so both
// endpoints are rate-limited per IP and log only whitelisted, size-clamped
// fields — a hostile payload can neither flood the logs nor smuggle content.

const metricsRateLimit = rateLimitMiddleware({
  name: "client-metrics",
  limit: 120,
  windowMs: 5 * 60_000,
});

const MAX_FIELD_LENGTH = 128;

function pickFields(body: unknown, fields: readonly string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof body !== "object" || body === null) return out;
  for (const field of fields) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) out[field] = value;
    else if (typeof value === "boolean") out[field] = value;
    else if (typeof value === "string") out[field] = value.slice(0, MAX_FIELD_LENGTH);
  }
  return out;
}

const VITALS_FIELDS = [
  "name",
  "value",
  "rating",
  "route",
  "deviceClass",
  "connectionType",
  "authState",
  "vaultSizeBucket",
] as const;

const IMAGE_FIELDS = ["outcome", "ms", "attempts", "usedProxyFallback", "url"] as const;

router.post("/metrics/vitals", metricsRateLimit, (req: Request, res: Response) => {
  const vital = pickFields(req.body, VITALS_FIELDS);
  if (Object.keys(vital).length > 0) logger.info({ vital }, "web-vital");
  res.status(204).end();
});

router.post("/metrics/images", metricsRateLimit, (req: Request, res: Response) => {
  const imageMetric = pickFields(req.body, IMAGE_FIELDS);
  if (Object.keys(imageMetric).length > 0) logger.info({ imageMetric }, "image-metric");
  res.status(204).end();
});

export default router;

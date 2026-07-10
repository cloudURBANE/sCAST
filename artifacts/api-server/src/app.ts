import path from "node:path";
import { existsSync } from "node:fs";
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import cjRedirectRouter from "./routes/cjRedirect";
import { mountBeamAgent, isModelConfigured, resolveProvider } from "./beam-agent";
import { resolveTenant } from "./middlewares/tenant";
import { logger } from "./lib/logger";
import { parseAllowedOrigins } from "./lib/corsOrigins.ts";
import { captureException } from "./lib/sentry.ts";
import { frontendStaticDir } from "./paths";

const app: Express = express();
const frontendIndexPath = path.join(frontendStaticDir, "index.html");
const HASHED_STATIC_CACHE = "public, max-age=31536000, immutable";
const PUBLIC_MEDIA_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const SPA_SHELL_CACHE = "no-cache, max-age=0, must-revalidate";

// Number of reverse proxies in front of Express, used for `trust proxy` so
// `req.ip` (and thus per-IP rate limiting) reads the real client IP instead of a
// client-forgeable X-Forwarded-For entry. 1 = direct Railway; 2 = Vercel edge
// middleware → Railway. Override with TRUST_PROXY_HOPS when the topology differs.
function resolveTrustProxyHops(): number {
  const raw = process.env["TRUST_PROXY_HOPS"];
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn({ TRUST_PROXY_HOPS: raw }, "Invalid TRUST_PROXY_HOPS; defaulting to 1 proxy hop");
    return 1;
  }
  return parsed;
}

// `trust proxy` decides which value of the X-Forwarded-For chain becomes
// `req.ip`. Trusting the WHOLE chain (`true`) lets a client forge its own IP by
// prepending an X-Forwarded-For header, which defeats every per-IP rate limit
// (rateLimit.ts keys on req.ip). Trust only the number of proxies actually in
// front of us: 1 for a direct Railway deploy, 2 behind the Vercel edge
// middleware → Railway. Configurable via TRUST_PROXY_HOPS; defaults to 1.
app.set("trust proxy", resolveTrustProxyHops());

// Security headers (defense-in-depth on /api/* and the whole story for the
// self-hosted path). In production the CloudFront response-headers policies
// (infra/cloudfront.tf) are the primary source for the SPA's headers; helmet
// covers API responses and self-hosted deployments.
// - CSP off here: the CSP rollout is driven from CloudFront as Report-Only
//   first (see the production-readiness plan B2); enabling helmet's default CSP
//   now would enforce an unproven policy on the self-hosted SPA.
// - COEP off: it requires every cross-origin image to send CORP, which the
//   proxied fragrance images don't.
// - CORP off: deployments that set VITE_API_BASE_URL load /api/image-proxy
//   images cross-origin; helmet's default `same-origin` would block those
//   <img> loads.
// - HSTS off unless explicitly enabled: Express usually sits behind TLS-
//   terminating proxies (CloudFront/Railway) where the edge header wins; a
//   self-hosted deploy that terminates TLS itself can set HSTS_ENABLED=true.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: { action: "deny" },
    strictTransportSecurity:
      process.env["HSTS_ENABLED"] === "true"
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
  }),
);

app.use(
  // pino-http v11 tightened its generics: without an explicit CustomLevels the
  // call infers `string`, which rejects our default `pino.Logger<never>`. Pin
  // the Request/Response generics (so the `req.id` serializer stays valid) and
  // let CustomLevels fall back to its `never` default to match `logger`.
  pinoHttp<Request, Response>({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS allowlist. In the production topology the SPA and API are same-origin
// (CloudFront proxies /api/*), so browsers send no CORS preflight at all — this
// allowlist exists to stop third-party websites driving the cost-bearing
// endpoints (image pipeline, Beam turns) from victims' browsers. Unset env →
// `origin: false` (no CORS headers; same-origin requests are unaffected).
// Comma-separated exact origins, e.g. "https://app.example.com,http://localhost:5173".
// routes/imageProxy.ts keeps its own explicit ACAO:* for cross-origin <img> use.
const allowedOrigins = parseAllowedOrigins(process.env["CORS_ALLOWED_ORIGINS"]);
if (allowedOrigins === false) {
  logger.info(
    "CORS_ALLOWED_ORIGINS unset — no cross-origin browser access (same-origin SPA unaffected)",
  );
}
app.use(cors({ origin: allowedOrigins, credentials: false }));

// Body limits. A single 10mb limit on every route is a cheap memory-amplification
// vector: an unauthenticated caller can force the server to buffer 10mb per request
// on endpoints that only ever need a few hundred bytes. Default to a tight 256kb
// and grant the larger budget only to the two routes that legitimately accept a
// `data:image` preview inline (up to ~4mb — see services/incomingImageUrl.ts).
// Raw image uploads (routes/adminImages.ts) use their own express.raw parser with
// an image/* content-type, which these JSON/urlencoded parsers skip untouched.
const DEFAULT_BODY_LIMIT = "256kb";
const DATA_URL_BODY_LIMIT = "5mb";
const DATA_URL_JSON_PATHS = new Set(["/api/refresh-image", "/api/reimagine-bottle-image"]);

const jsonDefault = express.json({ limit: DEFAULT_BODY_LIMIT });
const jsonLarge = express.json({ limit: DATA_URL_BODY_LIMIT });
app.use((req, res, next) => {
  (DATA_URL_JSON_PATHS.has(req.path) ? jsonLarge : jsonDefault)(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));

// Bind every request to a tenant (host-based, default-tenant fallback) before
// any route runs, so authenticated and public endpoints alike are isolated.
app.use(resolveTenant);

app.use("/api", router);
app.use(cjRedirectRouter);

// Beam Agent (read-only, Phase 1). Mounted at /api/beam-agent. Routes require
// auth + rate-limit and stay inert until a model provider is configured
// (OPENROUTER_API_KEY in production, or ANTHROPIC_API_KEY) — an unconfigured run
// just emits a graceful `model_unavailable` event. See docs/beam-agent/.
mountBeamAgent(app);

// Deploy canary: without a model provider every Beam run returns
// `model_unavailable` and the SPA silently falls back to the scripted
// /api/scent-mission path — so the agent looks fine but never actually runs.
// Surface the missing key once at startup. See docs/beam-agent/09-deploy-checklist.md.
if (isModelConfigured()) {
  logger.info({ provider: resolveProvider() }, "Beam Agent model provider configured");
} else {
  logger.warn(
    "Beam Agent has no model provider — set OPENROUTER_API_KEY (production) or ANTHROPIC_API_KEY. " +
      "Until then every concierge turn falls back to the scripted /api/scent-mission path.",
  );
}

const serveFrontendUnavailable: RequestHandler = (req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api")) {
    next();
    return;
  }

  res.status(503).type("text/plain").send("Frontend build is unavailable. Please try again later.");
};

function setFrontendStaticCacheHeaders(res: Response, filePath: string): void {
  const rel = path.relative(frontendStaticDir, filePath).split(path.sep).join("/");
  if (rel === "index.html" || rel === "site.webmanifest") {
    res.setHeader("Cache-Control", SPA_SHELL_CACHE);
    return;
  }

  if (rel.startsWith("assets/")) {
    res.setHeader("Cache-Control", HASHED_STATIC_CACHE);
    return;
  }

  if (
    /^(nav|icons|social|beta)\//.test(rel) ||
    /^(opengraph-scentbeam-v2\.png|opengraph\.jpg|scent-concierge-avatar\.png|favicon\.svg)$/.test(rel)
  ) {
    res.setHeader("Cache-Control", PUBLIC_MEDIA_CACHE);
  }
}

if (existsSync(frontendStaticDir) && existsSync(frontendIndexPath)) {
  app.use(
    express.static(frontendStaticDir, {
      fallthrough: true,
      setHeaders: setFrontendStaticCacheHeaders,
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    // A hashed asset that no longer exists (stale client after a redeploy)
    // must 404, not fall through to the HTML shell: serving text/html for a
    // module script makes browsers throw an unrecoverable MIME-type error
    // instead of the network failure the SPA's stale-chunk reload recovery
    // recognizes.
    if (req.path.startsWith("/assets/")) {
      res.status(404).type("text/plain").send("Not Found");
      return;
    }
    res.setHeader("Cache-Control", SPA_SHELL_CACHE);
    res.sendFile(frontendIndexPath, (err) => {
      if (err) next(err);
    });
  });
} else {
  logger.warn(
    { frontendStaticDir, frontendIndexPath },
    "Frontend static build missing; build @workspace/scent-cast before serving the SPA",
  );
  app.use(serveFrontendUnavailable);
}

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const errorStatus =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number"
        ? err.statusCode
        : undefined;
  const statusCode =
    errorStatus && errorStatus >= 400 && errorStatus < 600
      ? errorStatus
      : res.statusCode >= 400 && res.statusCode < 600
        ? res.statusCode
        : 500;
  const isApiRequest = req.originalUrl === "/api" || req.originalUrl.startsWith("/api/");
  const errorMessage = statusCode === 404 ? "Not Found" : "Internal Server Error";

  req.log?.error(
    {
      err,
      req: {
        id: req.id,
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
      },
    },
    "Unhandled request error",
  );

  // Server faults go to Sentry (no-op when unconfigured); 4xx are client
  // behavior, not defects — keep them out of the error budget.
  if (statusCode >= 500) {
    captureException(err, { requestId: String(req.id ?? ""), path: req.path, method: req.method });
  }

  if (isApiRequest) {
    res.status(statusCode).json({ error: errorMessage });
    return;
  }

  res.status(statusCode).type("text/plain").send(errorMessage);
};

app.use(errorHandler);

export default app;

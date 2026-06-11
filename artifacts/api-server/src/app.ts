import path from "node:path";
import { existsSync } from "node:fs";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import cjRedirectRouter from "./routes/cjRedirect";
import { resolveTenant } from "./middlewares/tenant";
import { logger } from "./lib/logger";
import { frontendStaticDir } from "./paths";

const app: Express = express();
const frontendIndexPath = path.join(frontendStaticDir, "index.html");

app.set("trust proxy", true);

app.use(
  pinoHttp({
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
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Bind every request to a tenant (host-based, default-tenant fallback) before
// any route runs, so authenticated and public endpoints alike are isolated.
app.use(resolveTenant);

app.use("/api", router);
app.use(cjRedirectRouter);

const serveFrontendUnavailable: RequestHandler = (req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api")) {
    next();
    return;
  }

  res.status(503).type("text/plain").send("Frontend build is unavailable. Please try again later.");
};

if (existsSync(frontendStaticDir) && existsSync(frontendIndexPath)) {
  app.use(
    express.static(frontendStaticDir, {
      fallthrough: true,
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
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

  if (isApiRequest) {
    res.status(statusCode).json({ error: errorMessage });
    return;
  }

  res.status(statusCode).type("text/plain").send(errorMessage);
};

app.use(errorHandler);

export default app;

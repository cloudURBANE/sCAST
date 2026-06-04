import path from "node:path";
import { existsSync } from "node:fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import cjRedirectRouter from "./routes/cjRedirect";
import { resolveTenant } from "./middlewares/tenant";
import { logger } from "./lib/logger";
import { frontendStaticDir } from "./paths";

const app: Express = express();

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

if (existsSync(frontendStaticDir)) {
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
    res.sendFile(path.join(frontendStaticDir, "index.html"), (err) => {
      if (err) next(err);
    });
  });
} else {
  logger.warn(
    { frontendStaticDir },
    "Frontend static directory missing; build @workspace/scent-cast before serving the SPA",
  );
}

export default app;

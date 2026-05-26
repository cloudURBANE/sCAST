import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_ENGINE_ORIGIN = "https://srt-scent-engine-production.up.railway.app";

const ENGINE_BASE = (
  process.env.FRAGRANCE_ENGINE_URL ??
  process.env.VITE_FRAGRANCE_API_URL ??
  DEFAULT_ENGINE_ORIGIN
)
  .trim()
  .replace(/\/+$/, "");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

async function proxyToEngine(req: Request, res: Response) {
  const enginePath = req.path.replace(/^\/engine/, "") || "/";
  const queryIndex = req.originalUrl.indexOf("?");
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
  const targetUrl = `${ENGINE_BASE}/api${enginePath}${query}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value !== "string" || HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = JSON.stringify(req.body ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }

  try {
    const upstream = await fetch(targetUrl, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, targetUrl }, "fragrance engine proxy failed");
    res.status(502).json({
      error: "Fragrance engine unreachable",
      detail: message,
    });
  }
}

router.all("/engine/*path", proxyToEngine);

export default router;

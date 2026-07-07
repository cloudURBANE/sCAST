import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.ts";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function headerToString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

let warnedAdminSecretMissing = false;

export function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  const adminSecret = process.env.ADMIN_SECRET;

  // WS-18: an unset ADMIN_SECRET means admin auth is *not configured* — no secret
  // could ever authenticate. Returning 401 here misleads the caller into thinking
  // their secret is wrong; a 503 says the capability is unavailable. Warn once so
  // the misconfiguration is visible in logs rather than silent.
  if (!adminSecret) {
    if (!warnedAdminSecretMissing) {
      warnedAdminSecretMissing = true;
      logger.warn(
        "[adminSecret] ADMIN_SECRET is not set; admin endpoints are disabled and return 503.",
      );
    }
    res.status(503).json({ error: "Admin endpoints are not configured" });
    return;
  }

  const provided = headerToString(req.headers["x-admin-secret"]);
  if (!provided || !timingSafeEqualStrings(provided, adminSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

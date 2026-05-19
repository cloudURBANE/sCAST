import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

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

export function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  const adminSecret = process.env.ADMIN_SECRET;
  const provided = headerToString(req.headers["x-admin-secret"]);

  if (!adminSecret || !provided || !timingSafeEqualStrings(provided, adminSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

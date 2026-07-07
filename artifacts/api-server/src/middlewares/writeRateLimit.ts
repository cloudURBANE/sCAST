import type { Request } from "express";
import { rateLimitMiddleware } from "../lib/rateLimit";
import type { AuthRequest } from "./auth";

// Per-user write rate limits (production-readiness C4). These sit AFTER
// requireAuth so req.user is populated and the window is keyed per account, not
// per IP — a shared NAT can't throttle another user, and an authenticated abuser
// is capped on their own budget. The limits are deliberately generous: they exist
// to stop runaway loops / scripted floods, not to pace normal use. Reads (the
// frequently-polled GET /wardrobe) are never wrapped.

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Key by user id when authenticated (these run after requireAuth), else fall back
// to IP so the middleware is still safe if ever mounted on a public route.
function userOrIpKey(req: Request): string {
  const userId = (req as AuthRequest).user?.id;
  return userId ? `user:${userId}` : `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

const MINUTE_MS = 60_000;

/** Wardrobe mutations (add/edit/delete/visibility/worn/rebuild). */
export const wardrobeWriteRateLimit = rateLimitMiddleware({
  name: "wardrobe-write",
  limit: envInt("WARDROBE_WRITE_RATE_LIMIT", 120),
  windowMs: MINUTE_MS,
  keyFn: userOrIpKey,
});

/** Community mutations (posts, comments, reactions, votes). */
export const communityWriteRateLimit = rateLimitMiddleware({
  name: "community-write",
  limit: envInt("COMMUNITY_WRITE_RATE_LIMIT", 60),
  windowMs: MINUTE_MS,
  keyFn: userOrIpKey,
});

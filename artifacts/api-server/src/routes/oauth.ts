import { Router } from "express";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable, userTokensTable } from "@workspace/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { getTenantId } from "../middlewares/tenant";
import {
  requireAuth,
  isUndefinedColumnError,
  isUndefinedTableError,
  type AuthRequest,
} from "../middlewares/auth";
import { hashToken } from "../lib/tokenAuth";
import { mintHandoffCode, redeemHandoffCode } from "../lib/oauthCodeStore";
import { rateLimitMiddleware } from "../lib/rateLimit";

const router = Router();

// Per-IP limit on the auth surface (production-readiness C4). Guards the OAuth
// start/callback/exchange/logout endpoints against brute-force and flood: the
// exchange codes are already single-use + random, and logout rotates a token, so
// this is DoS/abuse protection rather than a credential guard. Generous window,
// env-overridable (a corporate NAT may need more) — a normal login is ~3 hits.
const OAUTH_RATE_LIMIT = (() => {
  const parsed = Number(process.env["OAUTH_RATE_LIMIT"]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
})();
const oauthRateLimit = rateLimitMiddleware({
  name: "oauth",
  limit: OAUTH_RATE_LIMIT,
  windowMs: 10 * 60 * 1000,
});

type UserRow = typeof usersTable.$inferSelect;

function getBaseUrl(req: import("express").Request): string {
  const explicit = process.env.OAUTH_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }
  const publicApp = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (publicApp) {
    return publicApp;
  }
  const frontend = process.env.FRONTEND_URL?.trim().replace(/\/+$/, "");
  if (frontend) {
    return frontend;
  }
  // Vercel (and other proxies) set these; Host is still the upstream (e.g. Railway).
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0]}`;
  }
  const dev = process.env.REPLIT_DEV_DOMAIN;
  if (dev) {
    return `https://${dev}`;
  }
  return `${req.protocol}://${req.get("host")}`;
}

async function findUserByOAuthSubject(
  subject: string,
  tenantId: string,
  req: import("express").Request,
): Promise<UserRow | null> {
  try {
    return (
      await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.tenantId, tenantId),
            eq(usersTable.oauthProvider, "google"),
            eq(usersTable.oauthSubject, subject),
          ),
        )
        .limit(1)
    )[0] ?? null;
  } catch (err) {
    // Some migrated DBs may not yet have oauth columns; keep auth working via email fallback.
    req.log.warn({ err }, "OAuth subject lookup unavailable, falling back to email lookup");
    return null;
  }
}

async function findUserByEmail(email: string, tenantId: string): Promise<UserRow | null> {
  return (
    await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.email, email)))
      .limit(1)
  )[0] ?? null;
}

async function linkGoogleSubjectBestEffort(
  userId: string,
  subject: string,
  pictureUrl: string | null,
  req: import("express").Request,
): Promise<void> {
  try {
    await db
      .update(usersTable)
      .set({
        oauthProvider: "google",
        oauthSubject: subject,
        ...(pictureUrl ? { pictureUrl } : {}),
      })
      // WS-10: only bind a subject to a row that has none. This makes the link
      // idempotent and, critically, makes it impossible to *rebind* an account
      // that is already owned by a different Google subject — the account-hijack
      // path. Callers must verify oauth_subject is null before relying on this.
      .where(and(eq(usersTable.id, userId), isNull(usersTable.oauthSubject)));
  } catch (err) {
    // Do not fail login when optional OAuth-link columns are missing/unmigrated.
    req.log.warn({ err, userId }, "Skipping OAuth column update for user");
  }
}

async function createGoogleUserWithFallback(
  email: string,
  subject: string,
  pictureUrl: string | null,
  tenantId: string,
  req: import("express").Request,
): Promise<UserRow> {
  // WS-10: atomic find-or-create. A double-clicked / racing first login can run
  // two callbacks for the same (tenant, email) concurrently; a plain insert would
  // make the loser throw on `users_tenant_email_unique` and surface a transient
  // server_error. `onConflictDoUpdate` on that unique target collapses the race to
  // a single row and always RETURNINGs it (inserted or pre-existing).
  //
  // Hijack-safety: this path is only reached when no row matched by subject OR by
  // email, so the only possible conflict is a concurrent insert for the same new
  // account. Even so, the SET uses coalesce(existing, excluded) so it can NEVER
  // overwrite an already-bound oauth_subject — mirrors linkGoogleSubjectBestEffort's
  // `WHERE oauth_subject IS NULL` guard and keeps the email-only account-claim
  // semantics owned by the caller, not this upsert.
  try {
    const [upserted] = await db
      .insert(usersTable)
      .values({
        tenantId,
        email,
        oauthProvider: "google",
        oauthSubject: subject,
        ...(pictureUrl ? { pictureUrl } : {}),
      })
      .onConflictDoUpdate({
        target: [usersTable.tenantId, usersTable.email],
        set: {
          oauthProvider: sql`coalesce(${usersTable.oauthProvider}, excluded.oauth_provider)`,
          oauthSubject: sql`coalesce(${usersTable.oauthSubject}, excluded.oauth_subject)`,
          ...(pictureUrl
            ? { pictureUrl: sql`coalesce(${usersTable.pictureUrl}, excluded.picture_url)` }
            : {}),
        },
      })
      .returning();
    if (upserted) return upserted;
  } catch (err) {
    // Some migrated DBs may not yet have the oauth columns; fall back to an atomic
    // email-only upsert so a concurrent insert still resolves to one row instead
    // of 500ing.
    req.log.warn({ err, email }, "OAuth-linked upsert failed, retrying email-only upsert");
  }

  try {
    const [emailOnly] = await db
      .insert(usersTable)
      .values({ tenantId, email })
      .onConflictDoUpdate({
        target: [usersTable.tenantId, usersTable.email],
        // No-op set (write the same email) so the conflicting row is RETURNINGed
        // without mutating any auth-bearing column.
        set: { email },
      })
      .returning();

    if (emailOnly) {
      return emailOnly;
    }
  } catch (err) {
    req.log.warn(
      { err, email },
      "Email-only upsert failed during OAuth callback; retrying existing lookup",
    );
  }

  const existing = await findUserByEmail(email, tenantId);
  if (existing) {
    return existing;
  }

  throw new Error("Failed to create user during Google OAuth callback");
}

/**
 * Mint a fresh bearer-token session for a login (production-readiness S2,
 * finishing C1). The plaintext token exists only in this function's return value
 * and the 60s handoff-code store — the DB keeps its SHA-256 hash in user_tokens,
 * so no live credential is ever at rest. One row per login: each device gets its
 * own session instead of sharing/rotating the legacy `users.token` column, and
 * logout deletes all of the user's rows (sign-out everywhere, same as before).
 *
 * Fallback: a live DB that predates migration 0002 (RUN_MIGRATIONS_ON_BOOT
 * disabled) has no user_tokens table — rotate the legacy users.token/token_hash
 * columns exactly like the pre-0002 code so login still works there.
 */
async function mintSessionToken(user: UserRow, req: import("express").Request): Promise<string> {
  const nextToken = randomUUID();
  try {
    await db.insert(userTokensTable).values({
      userId: user.id,
      tokenHash: hashToken(nextToken),
    });
    return nextToken;
  } catch (err) {
    if (!isUndefinedTableError(err)) throw err;
    req.log.warn({ userId: user.id }, "user_tokens not migrated yet — rotating legacy token column");
  }

  try {
    await db
      .update(usersTable)
      .set({
        token: nextToken,
        tokenHash: hashToken(nextToken),
        tokenIssuedAt: sql`coalesce(${usersTable.tokenIssuedAt}, now())`,
        tokenLastUsedAt: sql`now()`,
      })
      .where(eq(usersTable.id, user.id));
  } catch (err) {
    if (!isUndefinedColumnError(err)) throw err;
    // Oldest possible DB: no hash columns either — rotate the plaintext column only.
    await db.update(usersTable).set({ token: nextToken }).where(eq(usersTable.id, user.id));
  }
  return nextToken;
}

async function updateUserPictureBestEffort(
  userId: string,
  pictureUrl: string | null,
  req: import("express").Request,
): Promise<void> {
  if (!pictureUrl) return;

  try {
    await db
      .update(usersTable)
      .set({ pictureUrl })
      .where(eq(usersTable.id, userId));
  } catch (err) {
    req.log.warn({ err, userId }, "Skipping OAuth picture update for user");
  }
}

// --- Login-CSRF / auth-code-injection defense (state + PKCE) ---------------
//
// The authorization request now carries a cryptographically random `state` and a
// PKCE `code_challenge` (S256). Both the state and the matching `code_verifier`
// are stashed in a short-lived, HttpOnly, SameSite=Lax cookie before redirecting
// to Google. The callback verifies the returned `state` against the cookie
// (constant-time) and sends the `code_verifier` on the token exchange, so a code
// minted for an attacker cannot be replayed into a victim's session, and a code
// intercepted from the redirect cannot be exchanged without the verifier.
const OAUTH_STATE_COOKIE = "sc_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OAUTH_COOKIE_PATH = "/api/auth/google";

function oauthCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge?: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Secure in production; relaxed in dev so the flow works over http://localhost.
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_COOKIE_PATH,
  };
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Read a single cookie value from the raw request header (no cookie-parser dep). */
function readRequestCookie(req: import("express").Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

router.get("/auth/google", oauthRateLimit, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

  // Bind state + PKCE verifier to this browser via a short-lived cookie. The `.`
  // separator is safe because both halves are base64url (no `.` in that alphabet).
  res.cookie(OAUTH_STATE_COOKIE, `${state}.${codeVerifier}`, {
    ...oauthCookieOptions(),
    maxAge: OAUTH_STATE_TTL_MS,
  });

  const redirectUri = `${getBaseUrl(req)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get("/auth/google/callback", oauthRateLimit, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(503).send("Google OAuth is not configured");
    return;
  }

  const code = req.query.code as string | undefined;
  if (!code) {
    res.redirect("/?oauth_error=no_code");
    return;
  }

  // Login-CSRF / auth-code-injection defense: the returned `state` must match the
  // value bound to this browser in the pre-redirect cookie. The cookie is single
  // use — clear it before doing anything else so it cannot be replayed.
  const stateCookie = readRequestCookie(req, OAUTH_STATE_COOKIE);
  res.clearCookie(OAUTH_STATE_COOKIE, oauthCookieOptions());
  const returnedState = typeof req.query.state === "string" ? req.query.state : "";
  const [expectedState, codeVerifier] = stateCookie ? stateCookie.split(".") : [];
  if (
    !stateCookie ||
    !expectedState ||
    !codeVerifier ||
    !returnedState ||
    !constantTimeEqual(expectedState, returnedState)
  ) {
    req.log.warn("Google OAuth callback state mismatch or missing; rejecting");
    res.redirect("/?oauth_error=invalid_state");
    return;
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/api/auth/google/callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
      // undici's fetch has no default timeout; a hung/half-open socket to Google
      // would otherwise leave this callback request pending indefinitely. Bound
      // it — an abort throws and is caught below (server_error redirect).
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenRes.ok) {
      res.redirect("/?oauth_error=token_exchange");
      return;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!userRes.ok) {
      res.redirect("/?oauth_error=user_info");
      return;
    }

    const googleUser = (await userRes.json()) as {
      sub: string;
      email: string;
      email_verified: boolean;
      picture?: string;
    };

    if (!googleUser.email || !googleUser.sub) {
      res.redirect("/?oauth_error=missing_email");
      return;
    }

    if (!googleUser.email_verified) {
      res.redirect("/?oauth_error=unverified_email");
      return;
    }

    const email = googleUser.email.toLowerCase();
    const subject = googleUser.sub;
    const pictureUrl = googleUser.picture?.trim() || null;
    const tenantId = getTenantId(req);
    let user = await findUserByOAuthSubject(subject, tenantId, req);

    if (!user) {
      const byEmail = await findUserByEmail(email, tenantId);
      if (byEmail) {
        // WS-10: a row already exists for this verified email but was not found by
        // subject above. Only adopt it when it has NO oauth_subject yet (a legacy /
        // email-only / admin-created account the verified owner is now claiming).
        // If it is already bound to a *different* Google subject, refuse rather than
        // rebind it — that would hand one Google identity another's account/wardrobe.
        if (byEmail.oauthSubject && byEmail.oauthSubject !== subject) {
          req.log.warn(
            { userId: byEmail.id },
            "OAuth email already bound to a different subject; refusing to rebind",
          );
          res.redirect("/?oauth_error=account_conflict");
          return;
        }
        user = byEmail;
        await linkGoogleSubjectBestEffort(byEmail.id, subject, pictureUrl, req);
      } else {
        user = await createGoogleUserWithFallback(email, subject, pictureUrl, tenantId, req);
      }
    }

    if (!user?.email) {
      throw new Error("OAuth callback resolved user without email");
    }

    const sessionToken = await mintSessionToken(user, req);
    await updateUserPictureBestEffort(user.id, pictureUrl, req);

    // C3: hand the SPA a single-use 60s code instead of the bearer token +
    // email in the redirect URL, so the live credential never lands in history,
    // Referer, or SPA-origin logs. The SPA POSTs it to /api/auth/exchange.
    const handoffCode = mintHandoffCode({
      token: sessionToken,
      email: user.email,
      ...(pictureUrl ? { pictureUrl } : {}),
    });
    res.redirect(`/?oauth_code=${encodeURIComponent(handoffCode)}`);
  } catch (err) {
    req.log.error(
      { err, query: req.query, resolvedBaseUrl: getBaseUrl(req) },
      "Google OAuth callback error",
    );
    res.redirect("/?oauth_error=server_error");
  }
});

/**
 * WS-18: server-side sign-out. Clearing the token only client-side leaves a
 * valid credential live (e.g. if it leaked into history/logs), so delete ALL of
 * the user's user_tokens sessions — sign-out everywhere, matching the legacy
 * column-rotation semantics. Best-effort and idempotent — the client clears
 * local state regardless of the response.
 */
router.post("/auth/logout", oauthRateLimit, requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  try {
    await db.delete(userTokensTable).where(eq(userTokensTable.userId, user.id));
  } catch (err) {
    if (!isUndefinedTableError(err)) {
      req.log.error({ err, userId: user.id }, "Failed to delete sessions on logout");
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    // Live DB predating migration 0002: fall back to the legacy column rotation.
    const nextToken = randomUUID();
    try {
      await db
        .update(usersTable)
        .set({
          token: nextToken,
          tokenHash: hashToken(nextToken),
          tokenIssuedAt: sql`now()`,
          tokenLastUsedAt: sql`now()`,
        })
        .where(eq(usersTable.id, user.id));
    } catch (fallbackErr) {
      req.log.error({ err: fallbackErr, userId: user.id }, "Failed to rotate token on logout");
      res.status(500).json({ error: "Logout failed" });
      return;
    }
  }

  // Transition hygiene: during a rolling deploy an old (pre-S2) instance still
  // authenticates against users.token_hash — null it so the logged-out
  // credential dies there too. Dead data after cutover; dropped with the legacy
  // columns in the follow-up contraction migration.
  try {
    await db.update(usersTable).set({ tokenHash: null }).where(eq(usersTable.id, user.id));
  } catch {
    /* non-fatal — column may already be dropped */
  }

  res.json({ ok: true });
});

/**
 * C3: exchange a one-time handoff code (minted by the OAuth callback) for the
 * bearer token + email. Single-use and 60s-lived (enforced by the store), so a
 * leaked redirect URL is worthless. The token is returned in the response body,
 * never in a URL. A rate limit is applied at mount (routes/index.ts).
 */
router.post("/auth/exchange", oauthRateLimit, (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!code) {
    res.status(400).json({ error: "Missing code" });
    return;
  }
  const handoff = redeemHandoffCode(code);
  if (!handoff) {
    res.status(401).json({ error: "Invalid or expired code" });
    return;
  }
  res.json({
    token: handoff.token,
    email: handoff.email,
    ...(handoff.pictureUrl ? { picture: handoff.pictureUrl } : {}),
  });
});

export default router;

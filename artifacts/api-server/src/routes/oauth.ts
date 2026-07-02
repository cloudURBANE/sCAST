import { Router } from "express";
import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { getTenantId } from "../middlewares/tenant";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router = Router();

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

async function ensureUserToken(
  user: UserRow,
  req: import("express").Request,
): Promise<UserRow> {
  if (user.token) {
    return user;
  }

  const nextToken = randomUUID();
  req.log.warn({ userId: user.id }, "User missing token after DB migration; repairing");
  const [updated] = await db
    .update(usersTable)
    .set({ token: nextToken })
    .where(eq(usersTable.id, user.id))
    .returning();

  if (!updated?.token) {
    throw new Error("Failed to repair missing user token");
  }

  return updated;
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

// Short-lived cookies that carry the CSRF `state` and the PKCE `code_verifier`
// from the outbound /auth/google redirect to the inbound callback. httpOnly so the
// page can't read them; SameSite=Lax so the browser still sends them on the
// top-level GET navigation Google performs back to the callback; scoped to the auth
// path; 10-minute lifetime (a login round-trip is far shorter).
const OAUTH_STATE_COOKIE = "oauth_state";
const OAUTH_PKCE_COOKIE = "oauth_pkce";
const OAUTH_TX_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function oauthTxCookieOptions(req: import("express").Request) {
  return {
    httpOnly: true,
    secure: req.secure,
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: OAUTH_TX_COOKIE_MAX_AGE_MS,
  };
}

/** Base64url with no padding, per RFC 7636 §4.1 / OAuth `state` conventions. */
function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse a single cookie value out of the raw `Cookie` header (no cookie-parser mounted). */
function readCookie(req: import("express").Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Constant-time string compare so `state` verification doesn't leak via timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

router.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  // CSRF `state` + PKCE `code_verifier`: bind this authorization request to the
  // browser that started it. Without them a victim's callback can be completed with
  // an attacker-supplied `code` (login-CSRF / code injection). The verifier never
  // leaves our server except as its S256 hash in the authorization URL.
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

  res.cookie(OAUTH_STATE_COOKIE, state, oauthTxCookieOptions(req));
  res.cookie(OAUTH_PKCE_COOKIE, codeVerifier, oauthTxCookieOptions(req));

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

router.get("/auth/google/callback", async (req, res) => {
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

  // CSRF defense: the `state` echoed by Google must match the one we set in the
  // httpOnly cookie when this browser started the flow. A forged callback (attacker's
  // code, victim's browser) carries no matching cookie → rejected. Clear the
  // single-use transaction cookies regardless of outcome.
  const expectedState = readCookie(req, OAUTH_STATE_COOKIE);
  const returnedState = typeof req.query.state === "string" ? req.query.state : "";
  const codeVerifier = readCookie(req, OAUTH_PKCE_COOKIE);
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/api/auth" });
  res.clearCookie(OAUTH_PKCE_COOKIE, { path: "/api/auth" });

  if (!expectedState || !returnedState || !safeEqual(expectedState, returnedState)) {
    req.log.warn("OAuth callback state mismatch; rejecting possible login-CSRF");
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
        // PKCE: proves this token exchange comes from the same client that made the
        // authorization request. Omitted only if the verifier cookie was lost.
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
    });

    if (!tokenRes.ok) {
      res.redirect("/?oauth_error=token_exchange");
      return;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
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

    user = await ensureUserToken(user, req);
    await updateUserPictureBestEffort(user.id, pictureUrl, req);

    if (!user.token) {
      throw new Error("OAuth callback resolved user without token/email");
    }

    const params = new URLSearchParams({
      oauth_token: user.token,
      oauth_email: user.email,
    });
    if (pictureUrl) {
      params.set("oauth_picture", pictureUrl);
    }

    res.redirect(`/?${params}`);
  } catch (err) {
    req.log.error(
      { err, query: req.query, resolvedBaseUrl: getBaseUrl(req) },
      "Google OAuth callback error",
    );
    res.redirect("/?oauth_error=server_error");
  }
});

/**
 * WS-18: server-side sign-out. The bearer token is the long-lived `users.token`
 * embedded in the OAuth redirect, so clearing it only client-side leaves a valid
 * credential live (e.g. if it leaked into history/logs). Rotating the column
 * invalidates the old token everywhere. Best-effort and idempotent — the client
 * clears local state regardless of the response.
 */
router.post("/auth/logout", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  try {
    await db
      .update(usersTable)
      .set({ token: randomUUID() })
      .where(eq(usersTable.id, user.id));
  } catch (err) {
    req.log.error({ err, userId: user.id }, "Failed to rotate token on logout");
    res.status(500).json({ error: "Logout failed" });
    return;
  }
  res.json({ ok: true });
});

export default router;

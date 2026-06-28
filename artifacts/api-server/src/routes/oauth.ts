import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getTenantId } from "../middlewares/tenant";

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
  try {
    const [created] = await db
      .insert(usersTable)
      .values({
        tenantId,
        email,
        oauthProvider: "google",
        oauthSubject: subject,
        ...(pictureUrl ? { pictureUrl } : {}),
      })
      .returning();
    if (created) return created;
  } catch (err) {
    req.log.warn({ err, email }, "Creating OAuth-linked user failed, retrying email-only user");
  }

  try {
    const [createdEmailOnly] = await db
      .insert(usersTable)
      .values({ tenantId, email })
      .returning();

    if (createdEmailOnly) {
      return createdEmailOnly;
    }
  } catch (err) {
    req.log.warn(
      { err, email },
      "Email-only user create failed during OAuth callback; retrying existing lookup",
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

router.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  const redirectUri = `${getBaseUrl(req)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
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

export default router;

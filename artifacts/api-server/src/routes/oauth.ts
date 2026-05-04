import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

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
    };

    if (!googleUser.email || !googleUser.sub) {
      res.redirect("/?oauth_error=missing_email");
      return;
    }

    const email = googleUser.email.toLowerCase();
    const subject = googleUser.sub;

    let user = (
      await db
        .select()
        .from(usersTable)
        .where(and(eq(usersTable.oauthProvider, "google"), eq(usersTable.oauthSubject, subject)))
        .limit(1)
    )[0];

    if (!user) {
      const byEmail = (
        await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
      )[0];

      if (byEmail) {
        const [updated] = await db
          .update(usersTable)
          .set({ oauthProvider: "google", oauthSubject: subject })
          .where(eq(usersTable.id, byEmail.id))
          .returning();
        user = updated;
      } else {
        const [created] = await db
          .insert(usersTable)
          .values({ email, oauthProvider: "google", oauthSubject: subject })
          .returning();
        user = created;
      }
    }

    const params = new URLSearchParams({
      oauth_token: user.token,
      oauth_email: user.email,
    });

    res.redirect(`/?${params}`);
  } catch (err) {
    req.log.error(err, "Google OAuth callback error");
    res.redirect("/?oauth_error=server_error");
  }
});

export default router;

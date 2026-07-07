/**
 * Admin gate for user-authenticated routes.
 *
 * Distinct from `middlewares/adminSecret.ts` (the ops-only `x-admin-secret`
 * shared secret, never exposed to the SPA). This gate layers on top of the
 * existing per-user bearer auth: a signed-in user counts as admin only when
 * their email is in the `ADMIN_EMAILS` allowlist. No schema change, no new auth
 * system — just an allowlist check against the already-authenticated user.
 */

/**
 * Parse the comma/whitespace-separated `ADMIN_EMAILS` env into a lowercase set.
 *
 * The allowlist is entirely env-driven — no address is hardcoded here. Baking an
 * owner address into source shipped PII in the repo and granted that account
 * admin on *every* deployment of this code with no way to revoke it via config.
 * Set `ADMIN_EMAILS` in the runtime environment (Railway variables / `.env`).
 */
export function getAdminEmailAllowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmailAllowlist().has(email.trim().toLowerCase());
}

export function isAdminUser(user: { email?: string | null } | null | undefined): boolean {
  return isAdminEmail(user?.email ?? null);
}

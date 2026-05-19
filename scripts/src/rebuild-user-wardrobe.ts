/**
 * Admin: rebuild every fragrance in a specific user's vault.
 *
 *   pnpm --filter @workspace/scripts rebuild-user -- --email you@example.com
 *
 * Hits the running API server (so it reuses the same buildProfile pipeline,
 * Firestore image cache, and global catalog as the live app — no risk of
 * the script and server going out of sync). The default base URL is
 * http://localhost:3000; override with --base or API_BASE_URL env.
 *
 * Requires ADMIN_SECRET (same value as the API server's env). Calls
 * POST /api/admin/wardrobe/rebuild — does not mint bearer tokens.
 *
 * Why this exists: legacy wardrobe rows persisted only `product.name`/
 * `product.brand` (no flat keys) and the dashboard filters them out. This
 * script and the matching rebuild routes normalize those rows so both the
 * dashboard and share pages line up again.
 */

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const email = arg("email");
const base =
  arg("base") ?? process.env.API_BASE_URL ?? "http://localhost:3000";
const adminSecret = process.env.ADMIN_SECRET;

if (!email) {
  console.error("usage: rebuild-user --email <user@example.com> [--base http://host:port]");
  process.exit(1);
}

if (!adminSecret) {
  console.error("ADMIN_SECRET is required (set in env, same as the API server)");
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[rebuild-user] target email: ${email}`);
  console.log(`[rebuild-user] api base:     ${base}`);

  const rebuildRes = await fetch(`${base}/api/admin/wardrobe/rebuild`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": adminSecret,
    },
    body: JSON.stringify({ email }),
  });
  if (!rebuildRes.ok) {
    const text = await rebuildRes.text().catch(() => "");
    throw new Error(`rebuild failed: HTTP ${rebuildRes.status} ${text}`);
  }

  const summary = (await rebuildRes.json()) as {
    total: number;
    rebuilt: number;
    skipped: number;
    failures: { id: string; reason: string }[];
  };

  console.log(
    `[rebuild-user] total=${summary.total} rebuilt=${summary.rebuilt} skipped=${summary.skipped}`,
  );
  if (summary.failures.length) {
    console.log("[rebuild-user] failures:");
    for (const f of summary.failures) console.log(`  - ${f.id}: ${f.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

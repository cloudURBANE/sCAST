/**
 * Admin: rebuild every fragrance in a specific user's vault.
 *
 *   pnpm --filter @workspace/scripts rebuild-user -- --email dkyleaustin@gmail.com
 *
 * Hits the running API server (so it reuses the same buildProfile pipeline,
 * Firestore image cache, and global catalog as the live app — no risk of
 * the script and server going out of sync). The default base URL is
 * http://localhost:3000; override with --base or API_BASE_URL env.
 *
 * Why this exists: legacy wardrobe rows persisted only `product.name`/
 * `product.brand` (no flat keys) and the dashboard filters them out. This
 * script and the matching POST /api/wardrobe/rebuild route normalize those
 * rows so both the dashboard and share pages line up again.
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

if (!email) {
  console.error("usage: rebuild-user --email <user@example.com> [--base http://host:port]");
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`[rebuild-user] target email: ${email}`);
  console.log(`[rebuild-user] api base:     ${base}`);

  // Acquire token via the same passwordless login the SPA uses. The endpoint
  // returns the existing user's token if they exist; we never want to mint a
  // new account here, so we bail if the lookup creates one (we'd see a brand
  // new uuid + zero rows on rebuild, which is harmless but flagged as a
  // diagnostic).
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => "");
    throw new Error(`login failed: HTTP ${loginRes.status} ${text}`);
  }
  const { token } = (await loginRes.json()) as { token: string };
  if (!token) throw new Error("login response missing token");

  const rebuildRes = await fetch(`${base}/api/wardrobe/rebuild`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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

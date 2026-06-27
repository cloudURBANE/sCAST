import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from the monorepo root .env file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Dynamic import AFTER dotenv: @workspace/db reads DATABASE_URL at module-init and
// static ESM imports hoist above dotenv.config().
const { repairDeadImageRefs } = await import(
  "../../artifacts/api-server/src/services/imageRepair"
);
const { isLocalImageObjectUrlPersistable } = await import(
  "../../artifacts/api-server/src/services/imageObjectStorage"
);
import type { ImageRepairPolicy } from "../../artifacts/api-server/src/services/imageRepairCore";

/*
 * Repair dead persisted image references.
 *
 * Processed-image URLs live INSIDE the JSONB of user_fragrances.fragrance_data
 * and global_fragrances.profile_data. When an old deploy baked a now-dead URL
 * there (an ephemeral /api/image-objects/... local ref in production, a base64
 * data URL, or a decommissioned bucket URL), the row keeps that dead string
 * forever: the live backfill only fills NULL images, and the read-path shared
 * substitution can be pinned by a dead http URL. This script CLEARS the dead
 * reference keys so the row re-resolves a fresh image on its next view. It never
 * deletes a stored object and never touches a URL it cannot prove is dead.
 *
 * Usage (from huge_monorepo/):
 *   pnpm --filter @workspace/scripts run repair:image-refs                 # DRY RUN (default)
 *   pnpm --filter @workspace/scripts run repair:image-refs -- --apply      # write changes
 *   ... --dead-prefix=https://old-bucket.firebasestorage.app/   # also clear URLs under this origin (repeatable)
 *   ... --keep-local-objects   # do NOT treat /api/image-objects/... as dead (dev DBs)
 */

const APPLY = process.argv.includes("--apply");
const KEEP_LOCAL = process.argv.includes("--keep-local-objects");
const DEAD_PREFIXES = process.argv
  .filter((a) => a.startsWith("--dead-prefix="))
  .map((a) => a.slice("--dead-prefix=".length))
  .filter((p) => p.length > 0);

async function main() {
  // In production local-object URLs are not durable, so they are dead by default;
  // a dev run (or --keep-local-objects) keeps them since the .image-cache/ files
  // may still exist.
  const localObjectUrlsAreDead = KEEP_LOCAL ? false : !isLocalImageObjectUrlPersistable();

  const policy: ImageRepairPolicy = {
    localObjectUrlsAreDead,
    deadUrlPrefixes: DEAD_PREFIXES,
  };

  console.log(
    `[repair-image-refs] mode=${APPLY ? "APPLY" : "DRY-RUN"} ` +
      `localObjectUrlsAreDead=${localObjectUrlsAreDead} ` +
      `deadPrefixes=${DEAD_PREFIXES.length ? DEAD_PREFIXES.join(",") : "(none)"}`,
  );

  const results = await repairDeadImageRefs(policy, { apply: APPLY });

  console.log("[repair-image-refs] summary:");
  let totalMatched = 0;
  for (const r of results) {
    totalMatched += r.matched;
    const verb = APPLY ? `cleared ${r.cleared}` : `${r.matched} would clear`;
    console.log(`  ${r.table.padEnd(18)} matched ${r.matched}; ${verb}`);
  }

  if (totalMatched === 0) {
    console.log("[repair-image-refs] no dead references found — nothing to do.");
  } else if (!APPLY) {
    console.log(
      "[repair-image-refs] DRY RUN — no rows were modified. Re-run with --apply to clear the dead references.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[repair-image-refs] failed:", err);
    process.exit(1);
  });

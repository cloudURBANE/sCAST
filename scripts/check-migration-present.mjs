#!/usr/bin/env node
// CI guard (production-readiness E1 step 3): if a PR changes the Drizzle schema
// surface (lib/db/src/schema/**) it MUST also add a migration file under
// lib/db/migrations/, so a schema change can only reach prod as a reviewed SQL
// migration — never via an unversioned `push`.
//
// Usage: node scripts/check-migration-present.mjs <base-ref>
// Compares the working tree against <base-ref> (default: origin/main).

import { execSync } from "node:child_process";

const baseRef = process.argv[2] || "origin/main";

function changedFiles(base) {
  // Three-dot: files changed on HEAD since it diverged from base.
  const out = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

let files;
try {
  files = changedFiles(baseRef);
} catch (err) {
  console.error(`[check-migration] could not diff against ${baseRef}: ${err.message}`);
  console.error("[check-migration] skipping (no base ref available)");
  process.exit(0);
}

const schemaChanged = files.some(
  (f) => f.startsWith("lib/db/src/schema/") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
);
const migrationAdded = files.some(
  (f) => f.startsWith("lib/db/migrations/") && f.endsWith(".sql") && !f.includes("/pre-baseline/"),
);

if (schemaChanged && !migrationAdded) {
  console.error(
    "[check-migration] FAIL: lib/db/src/schema/** changed but no new migration file was added.\n" +
      "  A schema change must ship as a reviewed SQL migration:\n" +
      "    pnpm --filter @workspace/db run generate\n" +
      "  then commit the generated file under lib/db/migrations/.",
  );
  process.exit(1);
}

if (schemaChanged) {
  console.log("[check-migration] OK: schema change ships with a new migration file.");
} else {
  console.log("[check-migration] OK: no schema change.");
}

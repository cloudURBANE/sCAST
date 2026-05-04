import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root `.env` for local runs (bundled entry resolves `dist/` → workspace root). */
export const repoRootDotenvPath = path.resolve(__dirname, "../../../.env");

/** Alternate env file used locally (same keys as `.env`; overrides after `.env` when present). */
export const repoRootScentCastEnvPath = path.resolve(
  __dirname,
  "../../../ScentCast.env",
);

/** Built Vite output for `artifacts/scent-cast` (sibling package under `artifacts/`). */
export const frontendStaticDir = path.resolve(
  __dirname,
  "..",
  "..",
  "scent-cast",
  "dist",
  "public",
);

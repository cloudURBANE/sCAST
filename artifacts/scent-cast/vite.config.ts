import fs from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Repo uses `ScentCast.env` for local secrets; Vite only reads `.env*` under this package by default.
 * If `VITE_FRAGRANCE_API_URL` is not already set (shell / scent-cast `.env`), pick it up from the root file.
 */
function applyFragranceCatalogUrlFromScentCastEnv() {
  if (process.env.VITE_FRAGRANCE_API_URL?.trim()) return;

  const file = path.join(REPO_ROOT, "ScentCast.env");
  if (!fs.existsSync(file)) return;

  const prefix = "VITE_FRAGRANCE_API_URL=";
  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(prefix)) continue;
    let value = line.slice(prefix.length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env.VITE_FRAGRANCE_API_URL = value;
    return;
  }
}

applyFragranceCatalogUrlFromScentCastEnv();

export default defineConfig(async ({ command }) => {
  const basePath = process.env.BASE_PATH ?? "/";

  const rawPort = process.env.PORT;
  let port = 5173;
  if (command === "serve") {
    if (!rawPort) {
      throw new Error(
        "PORT environment variable is required for dev/preview but was not provided.",
      );
    }
    port = Number(rawPort);
    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }
  }

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      ...(process.env.NODE_ENV !== "production" &&
      process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});

import fs from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Repo uses `ScentCast.env` for local secrets; Vite only reads `.env*` under this package by default.
 * Pick up public Vite API origins from the root file when they are not already set.
 */
function applyViteApiUrlsFromScentCastEnv() {
  const file = path.join(REPO_ROOT, "ScentCast.env");
  if (!fs.existsSync(file)) return;

  const keys = ["VITE_FRAGRANCE_API_URL", "VITE_API_BASE_URL"] as const;
  const missing = new Set(keys.filter((key) => !process.env[key]?.trim()));
  if (missing.size === 0) return;

  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!missing.has(key as (typeof keys)[number])) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      process.env[key] = value;
      missing.delete(key as (typeof keys)[number]);
    }
    if (missing.size === 0) return;
  }
}

applyViteApiUrlsFromScentCastEnv();

export default defineConfig(async () => {
  const basePath = process.env.BASE_PATH ?? "/";

  const rawPort = process.env.PORT?.trim();
  let port = 5173;
  if (rawPort) {
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
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            const normalizedId = id.replace(/\\/g, "/");
            if (
              normalizedId.includes("/react/") ||
              normalizedId.includes("/react-dom/") ||
              normalizedId.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (normalizedId.includes("/react-router/") || normalizedId.includes("/react-router-dom/")) {
              return "vendor-router";
            }
            if (normalizedId.includes("/@tanstack/")) {
              return "vendor-query";
            }
            if (normalizedId.includes("framer-motion") || normalizedId.includes("motion-dom")) {
              return "vendor-motion";
            }
            if (normalizedId.includes("web-vitals")) {
              return "vendor-vitals";
            }
            return undefined;
          },
        },
      },
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
      proxy: {
        "/api": {
          target:
            process.env.BACKEND_ORIGIN?.trim() ||
            process.env.VITE_API_BASE_URL?.trim() ||
            "https://scast-production.up.railway.app",
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});

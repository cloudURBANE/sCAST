import fs from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

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
      // Progressive Web App: offline-capable service worker.
      //
      // `injectManifest` (not `generateSW`) because we hand-author `src/sw.ts` to
      // add Web Push + notification-click handling alongside Workbox precache and
      // runtime caching. Workbox injects the precache list at `self.__WB_MANIFEST`.
      //
      // We deliberately do NOT let the plugin own the manifest or registration:
      //   - `manifest: false` — we ship our hand-tuned `public/site.webmanifest`
      //     (app shortcuts, maskable icons) already linked from `index.html`.
      //   - `injectRegister: null` — registration + the update prompt live in
      //     `src/lib/pwa/registerPwa.ts` so the SPA controls UX and timing.
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        registerType: "prompt",
        injectRegister: null,
        manifest: false,
        injectManifest: {
          // Precache the app shell only. The large icon set and bottle imagery
          // are runtime-cached in the SW instead of bloating the precache.
          globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
          globIgnores: ["**/icons/**", "**/nav/**", "**/social/**", "**/*.{png,jpg,jpeg,webp,avif,ico}"],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        // Keep the SW out of `vite dev` — it only ships in production builds, so
        // local HMR is never shadowed by a cached shell.
        devOptions: { enabled: false },
      }),
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
      // Pin the transpile floor so esbuild emits modern syntax instead of the
      // conservative default. es2020 + safari14 covers our installed-PWA target
      // baseline (iOS 14+ Safari) while still allowing optional chaining, nullish
      // coalescing, and dynamic import to ship untransformed — smaller, faster
      // entry code.
      target: ["es2020", "safari14"],
      // Our vendor split intentionally produces a few chunks above the 500 KB
      // default; raise the advisory threshold so the build log isn't noisy with
      // warnings for chunks we've deliberately sized.
      chunkSizeWarningLimit: 600,
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
            if (normalizedId.includes("/@radix-ui/")) {
              // Radix primitives are used across many always-loaded components;
              // isolating them keeps the rarely-changing UI vendor code in a
              // separately-cacheable chunk instead of bloating the entry chunk.
              return "vendor-radix";
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

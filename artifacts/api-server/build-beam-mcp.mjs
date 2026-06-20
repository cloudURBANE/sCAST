/**
 * Isolated esbuild for the Beam MCP server entrypoint.
 *
 * Mirrors build.mjs (same externals, pino plugin, ESM banner) but bundles ONLY
 * src/beam-agent/mcp/mcpMain.ts → dist-beam/beam-mcp.mjs. Kept separate from the
 * main build (which wipes dist/) so enabling Beam can never affect the API build.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { mkdir, readdir, rm } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Remove only the build outputs from dist-beam, never the runtime `*.log` files.
 *
 * The locally-running Beam MCP cockpit (`node ./dist-beam/beam-mcp.mjs`) keeps
 * open handles on `beam-mcp.out.log` / `beam-mcp.err.log`. A blanket
 * `rm dist-beam` therefore fails with EBUSY on Windows while that process is
 * alive, leaving the artifact swap blocked. Node loads the entry `.mjs` into
 * memory at startup and does not hold the file open, so the emitted bundle can
 * be overwritten in place — only the log handles are contended. Cleaning the
 * build outputs while preserving logs makes the rebuild succeed without having
 * to stop the owner's cockpit.
 */
async function cleanBuildOutputs(distDir) {
  await mkdir(distDir, { recursive: true });
  let entries;
  try {
    entries = await readdir(distDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => !name.endsWith(".log"))
      .map((name) => rm(path.join(distDir, name), { recursive: true, force: true })),
  );
}

async function buildBeamMcp() {
  const distDir = path.resolve(artifactDir, "dist-beam");
  await cleanBuildOutputs(distDir);

  await esbuild({
    entryPoints: [{ in: path.resolve(artifactDir, "src/beam-agent/mcp/mcpMain.ts"), out: "beam-mcp" }],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildBeamMcp().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node

const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const appRoot = path.resolve(__dirname, "..");
const viteBin = path.join(appRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
const port = Number(process.env.LHCI_PREVIEW_PORT || 4177);

let ready = false;
let stopped = false;

const child = spawn(
  viteBin,
  [
    "preview",
    "--config",
    "vite.config.ts",
    "--host",
    "0.0.0.0",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: appRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function stop(signal = "SIGTERM") {
  if (stopped) return;
  stopped = true;
  child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  if (!ready && !stopped) {
    process.exitCode = code ?? (signal ? 1 : 0);
  }
  process.exit();
});

const deadline = Date.now() + 60_000;

function poll() {
  if (ready || stopped) return;

  const request = http.get(
    {
      hostname: "127.0.0.1",
      port,
      path: "/",
      timeout: 1_000,
    },
    (response) => {
      response.resume();
      ready = true;
      console.log("LHCI preview ready");
    },
  );

  request.on("timeout", () => {
    request.destroy();
  });

  request.on("error", () => {
    if (Date.now() >= deadline) {
      console.error(`Timed out waiting for Vite preview on port ${port}`);
      stop();
      process.exitCode = 1;
      return;
    }
    setTimeout(poll, 250);
  });
}

poll();

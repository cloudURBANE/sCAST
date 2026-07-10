/**
 * Post-deploy browser smoke (readiness gap S4, browser half).
 *
 * Loads the freshly deployed SPA in real Chromium and fails when:
 *   - the shell does not return HTTP 200,
 *   - the SPA does not mount (#root stays empty),
 *   - the /arena deep route does not render through the SPA-routing rewrite,
 *   - a page JS error fires while a route loads,
 *   - the /api/* CloudFront proxy does not return the readyz contract.
 *
 * The full login → search → add-to-wardrobe → reload E2E requires a real
 * Google account and remains a manual step (docs/USER_LAUNCH_SETUP.md).
 *
 * CommonJS on purpose: the workflow installs the playwright library outside
 * the repo and exposes it via NODE_PATH, which ESM resolution ignores.
 *
 * Usage: NODE_PATH=<playwright node_modules> node smoke-browser.cjs --base-url https://scentbeam.com
 */
const { chromium } = require("playwright");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!key || value === undefined) {
      throw new Error("Arguments must be supplied as --key value pairs.");
    }
    args[key] = value;
  }
  if (!args["base-url"]) {
    throw new Error("Required argument: --base-url");
  }
  return { baseUrl: args["base-url"].replace(/\/$/, "") };
}

async function checkSpaRoute(context, url, label) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    if (!response || response.status() !== 200) {
      throw new Error(
        `${label}: expected HTTP 200, received ${response ? response.status() : "no response"}.`,
      );
    }
    // The SPA has mounted once React renders children into #root.
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#root");
        return root !== null && root.childElementCount > 0;
      },
      undefined,
      { timeout: 30_000 },
    );
    // Give late-loading chunks a moment to surface runtime errors.
    await page.waitForTimeout(2_000);
    if (pageErrors.length > 0) {
      throw new Error(`${label}: page JS errors: ${pageErrors.join(" | ")}`);
    }
    console.log(`ok - ${label}: HTTP 200, SPA mounted, no page errors`);
  } finally {
    await page.close();
  }
}

async function checkApiProxy(baseUrl) {
  const url = `${baseUrl}/api/readyz`;
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "scentbeam-deploy-smoke" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    throw new Error(`api proxy: expected HTTP 200 from ${url}, received ${response.status}.`);
  }
  const body = await response.json();
  const healthy =
    body?.status === "ready" && body?.checks?.db === "ok" && body?.checks?.redis === "ok";
  if (!healthy) {
    throw new Error(`api proxy: readyz contract mismatch: ${JSON.stringify(body)}`);
  }
  console.log("ok - api proxy: /api/readyz healthy through CloudFront");
}

async function main() {
  const { baseUrl } = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await checkSpaRoute(context, `${baseUrl}/`, "spa shell");
    await checkSpaRoute(context, `${baseUrl}/arena`, "deep route /arena");
    await checkApiProxy(baseUrl);
  } finally {
    await browser.close();
  }
  console.log(`Browser smoke passed against ${baseUrl}.`);
}

main().catch((error) => {
  console.error(`Browser smoke FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

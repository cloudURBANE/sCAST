import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_CONTRACT = {
  description: '{"status":"ready","checks":{"db":"ok","redis":"ok"}}',
  matches: (body) =>
    body?.status === "ready" &&
    body?.checks?.db === "ok" &&
    body?.checks?.redis === "ok",
};

const CONTRACTS = {
  api: API_CONTRACT,
  // Same Express /api/readyz contract, but reached through the canonical
  // CloudFront /api/* proxy behavior — catches CDN/proxy misconfiguration
  // that the direct Railway probe cannot see.
  web: API_CONTRACT,
  engine: {
    description: '{"ok":true,"db":"ok"}',
    matches: (body) => body?.ok === true && body?.db === "ok",
  },
};

export async function evaluateReadiness(service, url, response) {
  const contract = CONTRACTS[service];
  if (!contract) {
    throw new Error(`Unknown readiness service: ${service}`);
  }

  if (response.status !== 200) {
    return {
      ok: false,
      summary: `Expected HTTP 200; received HTTP ${response.status}.`,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      summary: `Expected application/json; received ${contentType || "no content type"}.`,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, summary: "Response body was not valid JSON." };
  }

  if (!contract.matches(body)) {
    return {
      ok: false,
      summary: `Response did not match the expected contract ${contract.description}.`,
    };
  }

  return { ok: true, summary: "HTTP status and readiness contract are healthy." };
}

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
  if (!args.service || !args.url || !args.output) {
    throw new Error("Required arguments: --service, --url, and --output.");
  }
  return args;
}

async function main() {
  const { service, url, output } = parseArgs(process.argv.slice(2));
  const checkedAt = new Date().toISOString();
  let result;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "scentbeam-readiness-monitor" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    result = {
      service,
      url,
      checkedAt,
      httpStatus: response.status,
      ...(await evaluateReadiness(service, url, response)),
    };
  } catch (error) {
    result = {
      service,
      url,
      checkedAt,
      httpStatus: null,
      ok: false,
      summary: `Readiness request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`${service}: ${result.summary}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

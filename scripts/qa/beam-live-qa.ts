import { randomUUID } from "node:crypto";
import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: join(import.meta.dirname, "../../.env"), override: false });
dotenv.config({ path: join(import.meta.dirname, "../../artifacts/api-server/.env"), override: true });
const hermesEnv = join(process.env.LOCALAPPDATA ?? "", "hermes", ".env");
dotenv.config({ path: hermesEnv, override: false });

const SCENARIOS = {
  "tokyo-2-plus-2": {
    message:
      "Plan a travel kit for Tokyo in August: exactly two bottles from my wardrobe and exactly two new ones. I want bold but not too sweet. Surprise me and make the picks now.",
  },
  "delegated-date-night": {
    message:
      "Pick one date-night fragrance for me from my wardrobe. I do not know what direction I want, so use your judgment and commit to the best choice now.",
  },
  "new-hot-humid": {
    message:
      "Recommend exactly two new fragrances I do not own for a brutally hot and humid rooftop dinner. Keep them fresh, polished, and not sweet.",
  },
  "compare-owned": {
    message:
      "Choose two fragrances from my wardrobe that overlap the most, compare them, and tell me which one to keep for evening wear.",
  },
} as const;

type ScenarioName = keyof typeof SCENARIOS;

function ownerScope(): { userId: string; tenantId: string } {
  const token = process.env.BEAM_AGENT_TOKEN?.trim();
  if (!token) throw new Error(`BEAM_AGENT_TOKEN is missing from ${hermesEnv}`);
  const payload = token.split(".")[1];
  if (!payload) throw new Error("BEAM_AGENT_TOKEN is malformed");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub?: unknown;
    tenantId?: unknown;
  };
  if (typeof claims.sub !== "string" || typeof claims.tenantId !== "string") {
    throw new Error("BEAM_AGENT_TOKEN is missing user or tenant scope");
  }
  return { userId: claims.sub, tenantId: claims.tenantId };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).find((arg) => arg !== "--") ?? "tokyo-2-plus-2";
  if (!(requested in SCENARIOS)) {
    throw new Error(`Unknown scenario "${requested}". Choose: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  const scenarioName = requested as ScenarioName;
  const scenario = SCENARIOS[scenarioName];
  const [{ runBeamAgent }, { deriveBeamSessionState }, { createBeamTools }, { createBeamServiceDeps }] =
    await Promise.all([
      import("../../artifacts/api-server/src/beam-agent/beamAgentLoop.ts"),
      import("../../artifacts/api-server/src/beam-agent/missionState.ts"),
      import("../../artifacts/api-server/src/beam-agent/beamTools.ts"),
      import("../../artifacts/api-server/src/beam-agent/mcp/beamServiceDeps.ts"),
    ]);
  const { userId, tenantId } = ownerScope();
  const runId = `qa_${randomUUID()}`;
  const events: unknown[] = [];
  let summary: unknown;

  await runBeamAgent({
    ctx: {
      runId,
      sessionId: `qa_session_${randomUUID()}`,
      tenantId,
      userId,
    },
    userMessage: scenario.message,
    sessionState: deriveBeamSessionState(undefined, scenario.message),
    tools: createBeamTools(createBeamServiceDeps()),
    emit: (event) => {
      events.push(event);
      process.stdout.write(`${JSON.stringify({ scenario: scenarioName, event })}\n`);
    },
    onSummary: (value) => {
      summary = value;
    },
  });

  process.stdout.write(`${JSON.stringify({ scenario: scenarioName, summary })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ failure: "qa_runner_error", message })}\n`);
  process.exitCode = 1;
});

/**
 * Pure unit tests for provider/lane → model resolution. No network.
 *   node --experimental-strip-types --test src/beam-agent/provider.test.ts
 *
 * Locks in the cost-critical invariant: the premium lane steps ORCHESTRATION up
 * to the cheap premium tier (M3) but reserves the strong (possibly Sonnet)
 * synthesis slug for the closing turn only — it is never the orchestration model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBeamModels } from "./provider.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(prev)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("OpenRouter premium lane keeps orchestration cheap (M3) and synthesis strong", () => {
  withEnv(
    {
      BEAM_AGENT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "test-key",
      BEAM_AGENT_MODEL: undefined,
      BEAM_AGENT_MODEL_PREMIUM: undefined,
      // Production-shaped override: the strong/synthesis slug is an expensive closer.
      BEAM_AGENT_MODEL_STRONG: "anthropic/claude-sonnet-4.6",
    },
    () => {
      const premium = resolveBeamModels("premium");
      assert.ok(premium);
      assert.equal(premium!.model, "minimax/minimax-m3");
      assert.equal(premium!.synthesisModel, "anthropic/claude-sonnet-4.6");
      // The blowup we are guarding against: premium orchestration == the closer.
      assert.notEqual(premium!.model, premium!.synthesisModel);

      const def = resolveBeamModels("default");
      assert.ok(def);
      assert.equal(def!.model, "minimax/minimax-m2.5");
      assert.equal(def!.synthesisModel, "anthropic/claude-sonnet-4.6");
    },
  );
});

test("Anthropic-direct keeps premium orchestration off the Sonnet synthesis slug", () => {
  withEnv(
    {
      BEAM_AGENT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key",
      BEAM_AGENT_MODEL: undefined,
      BEAM_AGENT_MODEL_PREMIUM: undefined,
      BEAM_AGENT_MODEL_STRONG: undefined,
    },
    () => {
      const premium = resolveBeamModels("premium");
      assert.ok(premium);
      // No mid-tier on Anthropic-direct: premium orchestration stays on the cheap
      // default (Haiku), synthesis escalates to the strong (Sonnet) closer.
      assert.equal(premium!.model, "claude-haiku-4-5-20251001");
      assert.equal(premium!.synthesisModel, "claude-sonnet-4-6");
      assert.notEqual(premium!.model, premium!.synthesisModel);
    },
  );
});

test("returns null when no provider credential is configured", () => {
  withEnv(
    { BEAM_AGENT_PROVIDER: "openrouter", OPENROUTER_API_KEY: undefined },
    () => {
      assert.equal(resolveBeamModels("default"), null);
    },
  );
});

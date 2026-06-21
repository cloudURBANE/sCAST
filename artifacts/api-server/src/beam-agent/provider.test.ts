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
import { isBeamAgentEnabled, resolveBeamBudget, resolveBeamModels } from "./provider.ts";
import { BEAM_LIMITS } from "./beamToolCore.ts";

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

test("lane-aware synthesis override routes each lane's closer independently", () => {
  withEnv(
    {
      BEAM_AGENT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "test-key",
      BEAM_AGENT_MODEL_STRONG: "anthropic/claude-sonnet-4.6",
      // Route everyday (default-lane) traffic to a cheap reasoning closer; keep
      // premium on the strong slug. This is the DeepSeek-V4 A/B drop-in.
      BEAM_AGENT_SYNTH_MODEL_DEFAULT: "deepseek/deepseek-v4-flash",
      BEAM_AGENT_SYNTH_MODEL_PREMIUM: undefined,
    },
    () => {
      const def = resolveBeamModels("default");
      const premium = resolveBeamModels("premium");
      assert.equal(def!.synthesisModel, "deepseek/deepseek-v4-flash");
      // Orchestration is untouched by the synthesis override.
      assert.equal(def!.model, "minimax/minimax-m2.5");
      // Premium lane, no override → falls back to the strong slug (unchanged).
      assert.equal(premium!.synthesisModel, "anthropic/claude-sonnet-4.6");
    },
  );
});

test("no synthesis override → both lanes keep the strong slug (default unchanged)", () => {
  withEnv(
    {
      BEAM_AGENT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "test-key",
      BEAM_AGENT_MODEL_STRONG: undefined,
      BEAM_AGENT_SYNTH_MODEL_DEFAULT: undefined,
      BEAM_AGENT_SYNTH_MODEL_PREMIUM: undefined,
    },
    () => {
      assert.equal(resolveBeamModels("default")!.synthesisModel, "minimax/minimax-m3");
      assert.equal(resolveBeamModels("premium")!.synthesisModel, "minimax/minimax-m3");
    },
  );
});

test("resolveBeamBudget defaults to the hardcoded limits when nothing is set", () => {
  withEnv(
    {
      BEAM_AGENT_MAX_TURNS_DEFAULT: undefined,
      BEAM_AGENT_MAX_TURNS_PREMIUM: undefined,
      BEAM_AGENT_ORCH_MAX_TOKENS: undefined,
      BEAM_AGENT_SYNTH_MAX_TOKENS: undefined,
    },
    () => {
      const budget = resolveBeamBudget("default");
      assert.equal(budget.maxTurns, BEAM_LIMITS.maxAgentTurns);
      assert.equal(budget.orchestrationMaxTokens, BEAM_LIMITS.orchestrationMaxTokens);
      assert.equal(budget.synthesisMaxTokens, BEAM_LIMITS.synthesisMaxTokens);
    },
  );
});

test("resolveBeamBudget honors per-lane env overrides and clamps maxTurns to the ceiling", () => {
  withEnv(
    {
      BEAM_AGENT_MAX_TURNS_DEFAULT: "3",
      // Above the hard ceiling — must be clamped, never exceed the server wall.
      BEAM_AGENT_MAX_TURNS_PREMIUM: "999",
      BEAM_AGENT_ORCH_MAX_TOKENS: "512",
      BEAM_AGENT_SYNTH_MAX_TOKENS: "1500",
    },
    () => {
      const free = resolveBeamBudget("default");
      assert.equal(free.maxTurns, 3);
      assert.equal(free.orchestrationMaxTokens, 512);
      assert.equal(free.synthesisMaxTokens, 1500);

      const premium = resolveBeamBudget("premium");
      assert.equal(premium.maxTurns, BEAM_LIMITS.maxAgentTurns);
    },
  );
});

test("resolveBeamBudget ignores blank/invalid env and falls back to defaults", () => {
  withEnv(
    { BEAM_AGENT_MAX_TURNS_DEFAULT: "  ", BEAM_AGENT_ORCH_MAX_TOKENS: "-5", BEAM_AGENT_SYNTH_MAX_TOKENS: "abc" },
    () => {
      const budget = resolveBeamBudget("default");
      assert.equal(budget.maxTurns, BEAM_LIMITS.maxAgentTurns);
      assert.equal(budget.orchestrationMaxTokens, BEAM_LIMITS.orchestrationMaxTokens);
      assert.equal(budget.synthesisMaxTokens, BEAM_LIMITS.synthesisMaxTokens);
    },
  );
});

test("isBeamAgentEnabled defaults ON when unset or blank", () => {
  withEnv({ BEAM_AGENT_ENABLED: undefined }, () => {
    assert.equal(isBeamAgentEnabled(), true);
  });
  withEnv({ BEAM_AGENT_ENABLED: "" }, () => {
    assert.equal(isBeamAgentEnabled(), true);
  });
  withEnv({ BEAM_AGENT_ENABLED: "   " }, () => {
    assert.equal(isBeamAgentEnabled(), true);
  });
});

test("isBeamAgentEnabled is OFF only for explicit falsey values (case/space-insensitive)", () => {
  for (const value of ["false", "0", "off", "no", "disabled", "OFF", " false ", " Disabled "]) {
    withEnv({ BEAM_AGENT_ENABLED: value }, () => {
      assert.equal(isBeamAgentEnabled(), false, `expected "${value}" to disable the agent`);
    });
  }
});

test("isBeamAgentEnabled stays ON for truthy / unrelated values", () => {
  for (const value of ["true", "1", "on", "yes", "enabled", "TRUE", " on "]) {
    withEnv({ BEAM_AGENT_ENABLED: value }, () => {
      assert.equal(isBeamAgentEnabled(), true, `expected "${value}" to keep the agent enabled`);
    });
  }
});

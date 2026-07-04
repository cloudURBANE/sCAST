import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisionGatePrompt,
  evaluateVisionGate,
  parseVisionGateAnswer,
  pickVisionApprovedWinner,
  type VisionGateCoreDeps,
  type VisionGateImage,
  type VisionGateVerdict,
} from "./imageVisionGateCore.ts";

const IMAGE: VisionGateImage = { data: Buffer.from("webp-bytes"), mimeType: "image/webp" };

function makeDeps(overrides: Partial<VisionGateCoreDeps> = {}): {
  deps: VisionGateCoreDeps;
  calls: { loadImage: number; askModel: string[] };
} {
  const calls = { loadImage: 0, askModel: [] as string[] };
  const deps: VisionGateCoreDeps = {
    enabled: () => true,
    loadImage: async () => {
      calls.loadImage += 1;
      return IMAGE;
    },
    askModel: async (prompt) => {
      calls.askModel.push(prompt);
      return "yes";
    },
    ...overrides,
  };
  return { deps, calls };
}

test("vision gate prompt names the exact fragrance and demands a one-word answer", () => {
  const prompt = buildVisionGatePrompt("Dior", "Sauvage  Elixir");
  assert.ok(prompt.includes('"Dior Sauvage Elixir"'));
  assert.match(prompt, /single product bottle/i);
  assert.match(prompt, /yes or no/i);
});

test("vision gate answer parsing accepts only leading yes/no and is otherwise unknown", () => {
  assert.equal(parseVisionGateAnswer("yes"), "yes");
  assert.equal(parseVisionGateAnswer("  Yes."), "yes");
  assert.equal(parseVisionGateAnswer('"NO"'), "no");
  assert.equal(parseVisionGateAnswer("No, this is a body lotion."), "no");
  assert.equal(parseVisionGateAnswer("Maybe"), "unknown");
  assert.equal(parseVisionGateAnswer("noteworthy bottle"), "unknown");
  assert.equal(parseVisionGateAnswer("yesterday's release"), "unknown");
  assert.equal(parseVisionGateAnswer(""), "unknown");
  assert.equal(parseVisionGateAnswer(undefined), "unknown");
});

test("gate disabled: pass-through with zero image loads and zero model calls", async () => {
  const { deps, calls } = makeDeps({ enabled: () => false });
  const verdict = await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage" });
  assert.equal(verdict, "pass");
  assert.equal(calls.loadImage, 0);
  assert.equal(calls.askModel.length, 0);
});

test("model says yes: winner accepted (pass)", async () => {
  const { deps, calls } = makeDeps({ askModel: async () => "Yes" });
  const verdict = await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage" });
  assert.equal(verdict, "pass");
  assert.equal(calls.loadImage, 1);
});

test("model says no: winner rejected", async () => {
  const { deps } = makeDeps({ askModel: async () => "no" });
  const verdict = await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage Elixir" });
  assert.equal(verdict, "reject");
});

test("model error fails open (pass) and is reported, never cached", async () => {
  const cache = new Map<string, VisionGateVerdict>();
  const errors: unknown[] = [];
  const { deps } = makeDeps({
    askModel: async () => {
      throw new Error("gemini 500");
    },
    cache,
    onError: (error) => errors.push(error),
  });
  const verdict = await evaluateVisionGate(deps, {
    brand: "Dior",
    name: "Sauvage",
    cacheKeys: ["k1"],
  });
  assert.equal(verdict, "pass");
  assert.equal(errors.length, 1);
  assert.equal(cache.size, 0, "fail-open passes must not be cached");
});

test("model timeout (rejected promise) fails open like any other error", async () => {
  const { deps } = makeDeps({
    askModel: () =>
      Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })),
  });
  assert.equal(await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage" }), "pass");
});

test("unloadable image fails open (pass) without a model call", async () => {
  const { deps, calls } = makeDeps({ loadImage: async () => null });
  assert.equal(await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage" }), "pass");
  assert.equal(calls.askModel.length, 0);
});

test("unparseable model answer fails open (pass) and is not cached", async () => {
  const cache = new Map<string, VisionGateVerdict>();
  const { deps } = makeDeps({ askModel: async () => "It depends on the angle.", cache });
  assert.equal(
    await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage", cacheKeys: ["k1"] }),
    "pass",
  );
  assert.equal(cache.size, 0);
});

test("definitive verdicts are cached under every key and reused without model spend", async () => {
  const cache = new Map<string, VisionGateVerdict>();
  let modelCalls = 0;
  const { deps, calls } = makeDeps({
    askModel: async () => {
      modelCalls += 1;
      return "no";
    },
    cache,
  });
  const input = { brand: "Dior", name: "Sauvage", cacheKeys: ["by-content", "by-source"] };

  assert.equal(await evaluateVisionGate(deps, input), "reject");
  assert.equal(modelCalls, 1);
  assert.equal(cache.get("by-content"), "reject");
  assert.equal(cache.get("by-source"), "reject");

  // Second evaluation (any of the keys) is a pure cache hit.
  assert.equal(
    await evaluateVisionGate(deps, { brand: "Dior", name: "Sauvage", cacheKeys: ["by-source"] }),
    "reject",
  );
  assert.equal(modelCalls, 1);
  assert.equal(calls.loadImage, 1);
});

test("verdict cache is bounded FIFO: oldest entry evicted at capacity", async () => {
  const cache = new Map<string, VisionGateVerdict>();
  const { deps } = makeDeps({ askModel: async () => "yes", cache, maxCacheEntries: 2 });
  await evaluateVisionGate(deps, { brand: "A", name: "1", cacheKeys: ["a"] });
  await evaluateVisionGate(deps, { brand: "B", name: "2", cacheKeys: ["b"] });
  await evaluateVisionGate(deps, { brand: "C", name: "3", cacheKeys: ["c"] });
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false, "oldest entry evicted");
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
});

test("winner arbitration: top-scored candidate passes and is returned (gate pass-through parity)", async () => {
  const winner = await pickVisionApprovedWinner(
    [
      { value: "second", score: 10, ordinal: 1 },
      { value: "first", score: 15, ordinal: 2 },
    ],
    async () => true,
  );
  assert.equal(winner?.value, "first");
});

test("winner arbitration: vision-rejected winner falls through to the next-best candidate", async () => {
  const rejected: string[] = [];
  const winner = await pickVisionApprovedWinner(
    [
      { value: "wrong-flanker", score: 20, ordinal: 1 },
      { value: "correct-bottle", score: 12, ordinal: 2 },
      { value: "never-gated", score: 5, ordinal: 3 },
    ],
    async (candidate) => candidate.value !== "wrong-flanker",
    (candidate) => rejected.push(candidate.value),
  );
  assert.equal(winner?.value, "correct-bottle");
  assert.deepEqual(rejected, ["wrong-flanker"], "only the presumptive winner was gated and rejected");
});

test("winner arbitration: all candidates rejected yields null (existing no-image semantics)", async () => {
  const rejected: number[] = [];
  const winner = await pickVisionApprovedWinner(
    [
      { value: "a", score: 20, ordinal: 1 },
      { value: "b", score: 12, ordinal: 2 },
    ],
    async () => false,
    (candidate) => rejected.push(candidate.ordinal),
  );
  assert.equal(winner, null);
  assert.deepEqual(rejected, [1, 2]);
});

test("winner arbitration: score ties resolve to the earliest ordinal (legacy best-tracking parity)", async () => {
  const winner = await pickVisionApprovedWinner(
    [
      { value: "later", score: 10, ordinal: 3 },
      { value: "earlier", score: 10, ordinal: 1 },
    ],
    async () => true,
  );
  assert.equal(winner?.value, "earlier");
});

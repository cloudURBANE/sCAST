import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySerperKeyFailure,
  dispatchImageCandidateSearch,
} from "./serperProviderCore.ts";

test("Serper retires every known exhausted-key response shape", () => {
  assert.equal(classifySerperKeyFailure(400, "Not enough credits"), "retire");
  assert.equal(classifySerperKeyFailure(400, "NOT ENOUGH CREDITS for this account"), "retire");
  assert.equal(classifySerperKeyFailure(401, undefined), "retire");
  assert.equal(classifySerperKeyFailure(402, undefined), "retire");
  assert.equal(classifySerperKeyFailure(403, undefined), "retire");
  assert.equal(classifySerperKeyFailure(429, "rate limit"), "cooldown");
  assert.equal(classifySerperKeyFailure(400, "invalid query"), "skip");
  assert.equal(classifySerperKeyFailure(500, "upstream failure"), "skip");
});

test("engine provider keeps a non-empty engine result without spending Serper", async () => {
  let engineCalls = 0;
  let serperCalls = 0;
  const result = await dispatchImageCandidateSearch({
    provider: "engine",
    searchEngine: async () => {
      engineCalls += 1;
      return ["engine-candidate"];
    },
    searchSerper: async () => {
      serperCalls += 1;
      return ["serper-candidate"];
    },
  });

  assert.deepEqual(result, {
    candidates: ["engine-candidate"],
    fallbackUsed: false,
  });
  assert.equal(engineCalls, 1);
  assert.equal(serperCalls, 0);
});

test("engine provider falls back to Serper when the engine has no usable candidates", async () => {
  let engineCalls = 0;
  let serperCalls = 0;
  const result = await dispatchImageCandidateSearch({
    provider: "engine",
    searchEngine: async () => {
      engineCalls += 1;
      return [];
    },
    searchSerper: async () => {
      serperCalls += 1;
      return ["serper-candidate"];
    },
  });

  assert.deepEqual(result, {
    candidates: ["serper-candidate"],
    fallbackUsed: true,
  });
  assert.equal(engineCalls, 1);
  assert.equal(serperCalls, 1);
});

test("engine provider reports fallback even when both providers are empty", async () => {
  const result = await dispatchImageCandidateSearch({
    provider: "engine",
    searchEngine: async () => [],
    searchSerper: async () => [],
  });

  assert.deepEqual(result, { candidates: [], fallbackUsed: true });
});

test("serper provider never calls the engine", async () => {
  let engineCalls = 0;
  const result = await dispatchImageCandidateSearch({
    provider: "serper",
    searchEngine: async () => {
      engineCalls += 1;
      return ["engine-candidate"];
    },
    searchSerper: async () => ["serper-candidate"],
  });

  assert.deepEqual(result, {
    candidates: ["serper-candidate"],
    fallbackUsed: false,
  });
  assert.equal(engineCalls, 0);
});

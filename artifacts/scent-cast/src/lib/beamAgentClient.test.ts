import test from "node:test";
import assert from "node:assert/strict";
import { runBeamAgentMission } from "./beamAgentClient.ts";

test("a broken agent stream stops the orphaned backend run", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length === 1) {
      return {
        ok: true,
        json: async () => ({
          runId: "run_1",
          sessionId: "s_1",
          eventsUrl: "/events/run_1",
        }),
      } as Response;
    }
    if (calls.length === 2) {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              throw new Error("stream dropped");
            },
            cancel: async () => undefined,
          }),
        },
      } as unknown as Response;
    }
    return { ok: true } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => runBeamAgentMission({ message: "hello", authToken: "token" }),
      /stream dropped/,
    );
    assert.equal(calls[2]?.url, "/api/beam-agent/runs/run_1/stop");
    assert.equal(calls[2]?.init?.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

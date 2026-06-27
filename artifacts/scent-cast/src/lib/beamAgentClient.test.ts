import test from "node:test";
import assert from "node:assert/strict";
import { runBeamAgentMission, BeamAgentError } from "./beamAgentClient.ts";

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
        status: 200,
        text: async () =>
          JSON.stringify({
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

test("an empty 2xx run-start body throws BeamAgentError, not a raw SyntaxError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => "" }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      () => runBeamAgentMission({ message: "hello", authToken: "token" }),
      (err: unknown) => err instanceof BeamAgentError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed (HTML) 2xx run-start body throws BeamAgentError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => "<!DOCTYPE html><html>502</html>" }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      () => runBeamAgentMission({ message: "hello", authToken: "token" }),
      (err: unknown) => err instanceof BeamAgentError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

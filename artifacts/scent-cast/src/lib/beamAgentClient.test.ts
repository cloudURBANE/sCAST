import test from "node:test";
import assert from "node:assert/strict";
import { runBeamAgentMission, loadBeamConversation, BeamAgentError } from "./beamAgentClient.ts";

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

test("loadBeamConversation returns ordered turns and sends the bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: "beam_abc",
        turns: [
          { role: "user", content: "date night" },
          { role: "assistant", content: "Try something warm and amber." },
        ],
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const turns = await loadBeamConversation({
      sessionId: "beam_abc",
      authToken: "tok",
      apiBaseUrl: "",
    });
    assert.deepEqual(turns, [
      { role: "user", content: "date night" },
      { role: "assistant", content: "Try something warm and amber." },
    ]);
    assert.equal(calls[0]?.url, "/api/beam-agent/conversations/beam_abc");
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization,
      "Bearer tok",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadBeamConversation resolves to [] for an empty transcript and drops malformed turns", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ sessionId: "s", turns: [] }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        turns: [
          { role: "user", content: "ok" },
          { role: "system", content: "nope" }, // not a valid conversation role
          { role: "assistant", content: 42 }, // non-string content
          { role: "assistant", content: "kept" },
        ],
      }),
    } as Response;
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await loadBeamConversation({ sessionId: "s", authToken: "t" }),
      [],
    );
    assert.deepEqual(
      await loadBeamConversation({ sessionId: "s", authToken: "t" }),
      [
        { role: "user", content: "ok" },
        { role: "assistant", content: "kept" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadBeamConversation throws BeamAgentError on a non-ok response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 401 }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      () => loadBeamConversation({ sessionId: "s", authToken: "t" }),
      (err: unknown) => err instanceof BeamAgentError && err.status === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

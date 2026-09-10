import test from "node:test";
import assert from "node:assert/strict";
import { launchFetch } from "./launchFetch.ts";

test("session headers reach only the app API and preserve explicit credentials", async () => {
  const originalFetch = globalThis.fetch;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const seen: Headers[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://scentbeam.com/",
        origin: "https://scentbeam.com",
      },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "test-session" },
  });
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}");
  };
  try {
    await launchFetch("/api/search-scent");
    await launchFetch("https://engine.example/api/search");
    await launchFetch("https://scentbeam.com/assets/image.png");
    await launchFetch("/api/search-scent", {
      headers: { Authorization: "Bearer explicit" },
    });
    assert.deepEqual(
      seen.map((h) => h.get("Authorization")),
      ["Bearer test-session", null, null, "Bearer explicit"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldStorage)
      Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

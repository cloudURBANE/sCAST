/**
 * Integration test for external discovery's /details enrichment (C1). Stubs
 * global fetch with a REAL engine response shape to pin that accords are read
 * from `derived_metrics.main_accords.top_accords` (not a top-level `accords`),
 * so deep-fetched picks no longer report `missingFields:["accords"]`. Run with:
 *   node --experimental-strip-types --test src/services/engineDiscover.test.ts
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { discoverExternalCandidates } from "./engineDiscover.ts";
import { packetFromExternalCandidate } from "../beam-agent/beamToolCore.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(detailsBody: unknown): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/api/fragrances/details")
      ? detailsBody
      : { results: [{ id: "frg-123", name: "Asad", house: "Lattafa", source_url: "https://x/asad" }] };
    return {
      ok: true,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

test("C1: /details accords are read from derived_metrics.main_accords.top_accords", async () => {
  // The shape the live engine actually emits (api.py + derived_metrics_adapter):
  // top_accords is a flat string[] under derived_metrics.main_accords.
  stubFetch({
    family: "Amber",
    raw: { notes: { top: ["pineapple"], heart: ["blackcurrant"], base: ["ambergris"] } },
    derived_metrics: { main_accords: { top_accords: ["sweet", "woody", "amber"] } },
  });

  const [candidate] = await discoverExternalCandidates("sweet woody clone", { limit: 1, detailLimit: 1 });
  assert.ok(candidate, "a candidate is returned");
  assert.equal(candidate.detailed, true, "the detail fetch was attempted");
  assert.deepEqual(candidate.accords, ["sweet", "woody", "amber"], "accords come from the nested path");

  // ...and the packet no longer reports accords as missing.
  const packet = packetFromExternalCandidate(candidate);
  assert.ok(!packet.missingFields.includes("accords"), "accords are no longer reported missing");
  assert.deepEqual(packet.accords, ["sweet", "woody", "amber"]);
});

test("C1: object-shaped accord elements ({accord}) are unwrapped, not dropped", async () => {
  stubFetch({
    derived_metrics: { main_accords: { top_accords: [{ accord: "leather" }, { accord: "smoky" }] } },
  });
  const [candidate] = await discoverExternalCandidates("leather", { limit: 1, detailLimit: 1 });
  assert.deepEqual(candidate.accords, ["leather", "smoky"]);
});

test("C1: legacy top-level accords still work as a fallback", async () => {
  stubFetch({ accords: ["citrus", "fresh"] });
  const [candidate] = await discoverExternalCandidates("fresh", { limit: 1, detailLimit: 1 });
  assert.deepEqual(candidate.accords, ["citrus", "fresh"]);
});

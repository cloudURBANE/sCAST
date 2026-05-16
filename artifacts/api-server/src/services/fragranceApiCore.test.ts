import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromSourceUrl,
  decodeIdentityId,
  encodeIdentityId,
  parseFragranceSourceUrl,
  scentFactProfileToDetail,
} from "./fragranceApiCore.ts";

test("parses Fragrantica source URLs into a usable fragrance identity", () => {
  const identity = parseFragranceSourceUrl(
    "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html?utm_source=x#reviews",
  );

  assert.equal(identity?.sourceUrl, "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html?utm_source=x#reviews");
  assert.equal(identity?.brand, "Dior");
  assert.equal(identity?.name, "Sauvage");
});

test("source-url search candidates never serialize blank identity fields", () => {
  const candidate = candidateFromSourceUrl(
    "https://www.fragrantica.com/perfume/French-Avenue/Liquid-Brun-98765.html",
    "French Avenue Liquid Brun",
  );

  assert.equal(candidate?.id, "source:https://www.fragrantica.com/perfume/French-Avenue/Liquid-Brun-98765.html");
  assert.equal(candidate?.brand, "French Avenue");
  assert.equal(candidate?.name, "Liquid Brun");
  assert.equal(candidate?.source_url, "https://www.fragrantica.com/perfume/French-Avenue/Liquid-Brun-98765.html");
});

test("identity ids round-trip without relying on blank detail fallbacks", () => {
  const id = encodeIdentityId("dataset", "Maison Francis Kurkdjian", "Baccarat Rouge 540");
  assert.deepEqual(decodeIdentityId(id), {
    brand: "Maison Francis Kurkdjian",
    name: "Baccarat Rouge 540",
  });
});

test("scent fact details carry source coverage and raw source URLs", () => {
  const detail = scentFactProfileToDetail({
    id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    sourceUrl: "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    profile: {
      brand: "Dior",
      name: "Sauvage",
      top_notes: ["bergamot"],
      heart_notes: ["pepper"],
      base_notes: ["ambroxan"],
      accords: ["fresh spicy"],
      confidence_score: 0.83,
      source_urls: ["https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html"],
    },
  });

  assert.equal(detail.name, "Sauvage");
  assert.equal(detail.brand, "Dior");
  assert.equal((detail.source_coverage as { complete?: boolean }).complete, true);
  assert.equal((detail.raw as { source_urls?: { frag_url?: string } }).source_urls?.frag_url, "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html");
});

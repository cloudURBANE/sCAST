import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromProfile,
  candidateFromSourceUrl,
  cleanQueryParam,
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

test("parses BaseNotes source URLs into a stable fragrance identity", () => {
  const identity = parseFragranceSourceUrl(
    "https://basenotes.com/fragrances/absolu-aventus-triple-aged-batch-by-creed.26272004",
  );

  assert.equal(
    identity?.sourceUrl,
    "https://basenotes.com/fragrances/absolu-aventus-triple-aged-batch-by-creed.26272004",
  );
  assert.equal(identity?.brand, "Creed");
  assert.equal(identity?.name, "Absolu Aventus Triple Aged Batch");
});

test("BaseNotes source candidates recover brand and name from the URL slug", () => {
  const candidate = candidateFromSourceUrl(
    "https://basenotes.com/fragrances/sauvage-by-dior.26147250",
    "Dior",
  );

  assert.equal(candidate?.id, "source:https://basenotes.com/fragrances/sauvage-by-dior.26147250");
  assert.equal(candidate?.brand, "Dior");
  assert.equal(candidate?.house, "Dior");
  assert.equal(candidate?.name, "Sauvage");
});

test("identity ids round-trip without relying on blank detail fallbacks", () => {
  const id = encodeIdentityId("dataset", "Maison Francis Kurkdjian", "Baccarat Rouge 540");
  assert.deepEqual(decodeIdentityId(id), {
    brand: "Maison Francis Kurkdjian",
    name: "Baccarat Rouge 540",
  });
});

test("identity id decoding allows colons inside the decoded brand", () => {
  const id = encodeIdentityId("catalog", "Brand: Edition", "Nocturne");
  assert.deepEqual(decodeIdentityId(id), {
    brand: "Brand: Edition",
    name: "Nocturne",
  });
});

test("decodes local fallback ids minted with single-colon raw segments", () => {
  assert.deepEqual(decodeIdentityId("local:Xerjoff:Naxos"), {
    brand: "Xerjoff",
    name: "Naxos",
  });
});

test("local id decoding keeps colons that belong to the fragrance name", () => {
  assert.deepEqual(decodeIdentityId("local:Dior:Sauvage: Elixir"), {
    brand: "Dior",
    name: "Sauvage: Elixir",
  });
});

test("rejects a local id that is missing its name segment", () => {
  assert.equal(decodeIdentityId("local:Xerjoff"), null);
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
  assert.equal((detail.source_coverage as { complete?: boolean }).complete, false);
  assert.equal((detail.source_coverage as { derived_metrics?: string }).derived_metrics, "partial");
  assert.equal((detail.raw as { source_urls?: { frag_url?: string } }).source_urls?.frag_url, "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html");
});

test("scent fact details complete only when both known source URLs have notes", () => {
  const detail = scentFactProfileToDetail({
    id: "source:https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
    profile: {
      brand: "Dior",
      name: "Sauvage",
      top_notes: ["bergamot"],
      heart_notes: ["pepper"],
      base_notes: ["ambroxan"],
      accords: ["fresh spicy"],
      confidence_score: 0.83,
      source_urls: [
        "https://www.fragrantica.com/perfume/Dior/Sauvage-31861.html",
        "https://basenotes.com/fragrances/sauvage-by-dior.26147250",
      ],
    },
  });

  assert.equal((detail.source_coverage as { complete?: boolean }).complete, true);
  assert.equal((detail.source_coverage as { derived_metrics?: string }).derived_metrics, "complete");
});

test("candidateFromProfile safely handles null/undefined/sparse product objects", () => {
  const c1 = candidateFromProfile("catalog", null as any);
  assert.equal(c1.name, "");
  assert.equal(c1.brand, undefined);
  assert.equal(c1.house, undefined);
  assert.equal(c1.id, "catalog:::");

  const c2 = candidateFromProfile("dataset", { product: { name: "Aventus", brand: undefined as any } } as any);
  assert.equal(c2.name, "Aventus");
  assert.equal(c2.brand, undefined);
  assert.equal(c2.house, undefined);
  assert.equal(c2.id, "dataset:::Aventus");
});

test("cleanQueryParam: supports array query params and strips control characters", () => {
  // Array parameters: takes first element
  assert.equal(cleanQueryParam(["Dior Sauvage", "Creed Aventus"]), "Dior Sauvage");
  assert.equal(cleanQueryParam([]), "");

  // Control characters stripped
  assert.equal(cleanQueryParam("Dior\x00Sauvage\x1fEDP"), "Dior Sauvage EDP");
  assert.equal(cleanQueryParam("\x00\x01\x1f"), "");
  assert.equal(cleanQueryParam("Sauvage\x7f"), "Sauvage");

  // Length truncation at 180 chars
  const long = "a".repeat(200);
  assert.equal(cleanQueryParam(long).length, 180);
});

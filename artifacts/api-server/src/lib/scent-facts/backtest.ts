import "../../env-bootstrap";
import { getScentFacts } from "./engine";

const CASES = [
  {
    fragranceName: "Creed Aventus",
    mustIncludeAny: [
      "pineapple",
      "bergamot",
      "black currant",
      "birch",
      "musk",
      "oakmoss",
    ],
  },
  {
    fragranceName: "Dior Sauvage Elixir",
    mustIncludeAny: [
      "cinnamon",
      "nutmeg",
      "cardamom",
      "lavender",
      "licorice",
      "sandalwood",
    ],
  },
  {
    fragranceName: "Tom Ford Tobacco Vanille",
    mustIncludeAny: ["tobacco", "vanilla", "cacao", "tonka bean", "dried fruits"],
  },
  {
    fragranceName: "Bleu de Chanel",
    mustIncludeAny: ["grapefruit", "incense", "ginger", "sandalwood", "cedar"],
  },
  {
    fragranceName: "Baccarat Rouge 540",
    mustIncludeAny: ["saffron", "jasmine", "amberwood", "fir resin", "cedar"],
  },
];

function allNotes(result: Awaited<ReturnType<typeof getScentFacts>>): string[] {
  return [
    ...result.profile.top_notes,
    ...result.profile.heart_notes,
    ...result.profile.base_notes,
    ...result.profile.accords,
  ];
}

async function main() {
  const results: Array<Record<string, unknown>> = [];

  for (const testCase of CASES) {
    const startedAt = Date.now();
    try {
      const result = await getScentFacts({
        fragranceName: testCase.fragranceName,
        save: false,
      });

      const notes = allNotes(result);
      const matched = testCase.mustIncludeAny.filter((n) => notes.includes(n));

      results.push({
        fragranceName: testCase.fragranceName,
        ok: true,
        duration_ms: Date.now() - startedAt,
        readable_sources: result.proof.readable_sources,
        confidence_score: result.profile.confidence_score,
        matched_expected_notes: matched,
        matched_count: matched.length,
        warnings: result.proof.warnings,
        unsupported_removed: result.proof.unsupported_notes_removed,
      });
    } catch (error) {
      results.push({
        fragranceName: testCase.fragranceName,
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const passed = results.filter((r) => {
    if (r.ok !== true) return false;
    const matchedCount = typeof r.matched_count === "number" ? r.matched_count : 0;
    return matchedCount >= 2;
  }).length;

  const report = {
    total: CASES.length,
    passed,
    failed: CASES.length - passed,
    pass_rate: passed / CASES.length,
    results,
  };

  console.log(JSON.stringify(report, null, 2));

  if (report.pass_rate < 0.7) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

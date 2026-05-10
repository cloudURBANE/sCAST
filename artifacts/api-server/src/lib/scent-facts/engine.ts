import { extractScentFacts } from "./extract";
import { factCheckProfile } from "./factCheck";
import { cleanQuery, isHttpUrl, readSources, searchScentSources } from "./jina";
import type { ScentFactInput, ScentFactResult } from "./types";

export async function getScentFacts(input: ScentFactInput): Promise<ScentFactResult> {
  const fragranceName = cleanQuery(input.fragranceName || "");
  if (!fragranceName) {
    throw new Error("fragranceName is required.");
  }
  if (input.save) {
    throw new Error("This lightweight engine is read-only. Save must remain false.");
  }

  const callerProvidedUrl =
    typeof input.sourceUrl === "string" && isHttpUrl(input.sourceUrl);

  const urls = callerProvidedUrl
    ? [input.sourceUrl as string]
    : await searchScentSources(fragranceName);

  if (!urls.length) {
    throw new Error("No trusted scent sources found.");
  }

  const sources = await readSources(urls);
  if (!sources.length) {
    throw new Error("No readable Jina sources found.");
  }

  const extracted = await extractScentFacts(fragranceName, sources);
  const checked = factCheckProfile(extracted, sources);

  // Single-URL calls with only one readable source are provisional
  const provisional = callerProvidedUrl && sources.length === 1;

  return {
    ok: true,
    ...(provisional && { provisional: true }),
    profile: checked.profile,
    proof: checked.proof,
  };
}

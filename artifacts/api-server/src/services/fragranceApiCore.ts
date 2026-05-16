import type { ScentFactProfile } from "../lib/scent-facts/types";
import type { ScentProfile } from "./scentEngine";

export type FragranceSearchCandidate = {
  id: string;
  name: string;
  house?: string;
  brand?: string;
  year?: number | null;
  gender?: string | null;
  source_url?: string | null;
};

export type SourceUrlIdentity = {
  sourceUrl: string;
  brand?: string;
  name: string;
};

function cleanSegment(value: string): string {
  return value
    .replace(/\.html?$/i, "")
    .replace(/-\d+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) =>
      /^(?:edp|edt|edc|dna|oud|ysl)$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function decodePathSegment(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function parseFragranceSourceUrl(value: string): SourceUrlIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const parts = parsed.pathname
    .split("/")
    .map(decodePathSegment)
    .filter(Boolean);

  if (parts.length === 0) return null;

  const perfumeIndex = parts.findIndex((part) => /^perfumes?$/i.test(part));
  const brandPart = perfumeIndex >= 0 ? parts[perfumeIndex + 1] : undefined;
  const namePart = perfumeIndex >= 0 ? parts[perfumeIndex + 2] : parts.at(-1);
  const name = titleCase(cleanSegment(namePart ?? ""));
  if (!name) return null;

  const brand = titleCase(cleanSegment(brandPart ?? ""));
  return {
    sourceUrl: parsed.toString(),
    ...(brand ? { brand } : {}),
    name,
  };
}

function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function encodeIdentityId(prefix: "catalog" | "dataset", brand: string, name: string): string {
  return `${prefix}:${encodeIdentityPart(brand)}::${encodeIdentityPart(name)}`;
}

export function decodeIdentityId(value: string): { brand: string; name: string } | null {
  const match = /^(?:catalog|dataset):([^:]+)::(.+)$/.exec(value);
  if (!match) return null;
  try {
    const brand = decodeURIComponent(match[1]).trim();
    const name = decodeURIComponent(match[2]).trim();
    return brand && name ? { brand, name } : null;
  } catch {
    return null;
  }
}

export function candidateFromSourceUrl(
  sourceUrl: string,
  fallbackQuery = "",
): FragranceSearchCandidate | null {
  const identity = parseFragranceSourceUrl(sourceUrl);
  if (!identity) return null;
  return {
    id: `source:${identity.sourceUrl}`,
    name: identity.name || fallbackQuery.trim(),
    house: identity.brand,
    brand: identity.brand,
    year: null,
    gender: null,
    source_url: identity.sourceUrl,
  };
}

export function candidateFromProfile(
  prefix: "catalog" | "dataset",
  profile: Pick<ScentProfile, "product">,
): FragranceSearchCandidate {
  const brand = profile.product.brand;
  const name = profile.product.name;
  return {
    id: encodeIdentityId(prefix, brand, name),
    name,
    house: brand,
    brand,
    year: null,
    gender: null,
    source_url: null,
  };
}

export function scentFactProfileToDetail(input: {
  id: string;
  sourceUrl?: string | null;
  profile: ScentFactProfile;
  proof?: unknown;
  imageProfile?: Record<string, unknown>;
  provisional?: boolean;
}): Record<string, unknown> {
  const flatNotes = [
    ...input.profile.top_notes,
    ...input.profile.heart_notes,
    ...input.profile.base_notes,
  ];
  const sourceUrls = input.profile.source_urls;
  const sourceUrl = input.sourceUrl ?? sourceUrls[0] ?? null;
  const sourceCoverage = {
    fragrantica: sourceUrls.some((url) => /fragrantica\.com/i.test(url)),
    basenotes: sourceUrls.some((url) => /basenotes\.com/i.test(url)),
    derived_metrics: flatNotes.length > 0 ? "complete" : "partial",
    complete: flatNotes.length > 0,
  };

  return {
    ...(input.imageProfile ?? {}),
    id: input.id,
    name: input.profile.name,
    house: input.profile.brand || undefined,
    brand: input.profile.brand || undefined,
    source_url: sourceUrl,
    source_coverage: sourceCoverage,
    derived_metrics: {
      headline: {
        crowd_consensus_score: input.profile.confidence_score,
        summary: sourceCoverage.complete
          ? `Verified against ${sourceUrls.length} scent source${sourceUrls.length === 1 ? "" : "s"}.`
          : undefined,
      },
      main_accords: {
        top_accords: input.profile.accords,
      },
      notes: {
        has_pyramid:
          input.profile.top_notes.length > 0 ||
          input.profile.heart_notes.length > 0 ||
          input.profile.base_notes.length > 0,
        top: input.profile.top_notes,
        heart: input.profile.heart_notes,
        base: input.profile.base_notes,
        flat: [...new Set(flatNotes)],
      },
      source_coverage: sourceCoverage,
    },
    enrichment: {
      status: input.provisional ? "pending" : "not_needed",
      requested_count: 0,
      message: input.provisional
        ? "Single-source detail is provisional."
        : "Detail is complete from readable scent sources.",
    },
    raw: {
      notes: {
        has_pyramid:
          input.profile.top_notes.length > 0 ||
          input.profile.heart_notes.length > 0 ||
          input.profile.base_notes.length > 0,
        top: input.profile.top_notes,
        heart: input.profile.heart_notes,
        base: input.profile.base_notes,
        flat: [...new Set(flatNotes)],
      },
      source_urls: {
        frag_url: sourceUrls.find((url) => /fragrantica\.com/i.test(url)),
        bn_url: sourceUrls.find((url) => /basenotes\.com/i.test(url)),
      },
      proof: input.proof,
    },
  };
}

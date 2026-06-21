/**
 * Beam research lane — deployment configuration (env-driven).
 *
 * Every model slug is read from the environment with a safe default. The defaults
 * below are the free/cheap stack (free Gemma concierge for single/standard/degraded
 * lanes, the strong hy3-preview closer for premium). Provider slugs drift, so treat
 * the defaults as a starting point and pin the exact slugs per deployment via env.
 * A banned/cost-opaque slug (`*:online`, `openrouter/auto`,
 * `openrouter/fusion`) falls back to the safe default rather than going to wire.
 *
 * Read at CALL TIME (functions, not module constants) so tests and ops can flip
 * env without a reload, mirroring openRouterProvider.ts.
 */
import type { ResearchMode } from "./researchPolicy.ts";
import { isBannedResearchModel } from "./researchPolicy.ts";

/** Default OpenRouter slugs per lane. Override with the matching env var. */
const DEFAULTS = {
  single: "google/gemma-4-31b-it:free",
  standard: "google/gemma-4-31b-it:free",
  premium: "tencent/hy3-preview",
  degraded: "google/gemma-4-31b-it:free",
} as const;

function pickModel(envVar: string, fallback: string): string {
  const raw = process.env[envVar]?.trim();
  if (raw && !isBannedResearchModel(raw)) return raw;
  return fallback;
}

/** The OpenRouter model slug for a given research mode. */
export function researchModelFor(mode: ResearchMode): string {
  switch (mode) {
    case "single_source_check":
      return pickModel("BEAM_RESEARCH_MODEL_SINGLE", DEFAULTS.single);
    case "standard_research":
      return pickModel("BEAM_RESEARCH_MODEL_STANDARD", DEFAULTS.standard);
    case "premium_research":
      return pickModel("BEAM_RESEARCH_MODEL_PREMIUM", DEFAULTS.premium);
    case "no_search_use_cache":
    default:
      return pickModel("BEAM_RESEARCH_MODEL_STANDARD", DEFAULTS.standard);
  }
}

/** The degraded fallback model (used when the primary research call fails). */
export function degradedResearchModel(): string {
  return pickModel("BEAM_RESEARCH_MODEL_DEGRADED", DEFAULTS.degraded);
}

/** Web-search engine for the OpenRouter `web` plugin. */
export function researchEngine(): string {
  const raw = process.env.BEAM_RESEARCH_ENGINE?.trim().toLowerCase();
  if (raw === "exa" || raw === "parallel" || raw === "native") return raw;
  return "exa";
}

/**
 * Domain allowlist for the web plugin (comma-separated env). Empty = no filter.
 * Keeping this tight is the single biggest cost/quality lever — small result
 * count, trusted domains.
 */
export function researchIncludeDomains(): string[] {
  const raw = process.env.BEAM_RESEARCH_INCLUDE_DOMAINS;
  if (!raw) return DEFAULT_INCLUDE_DOMAINS;
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

const DEFAULT_INCLUDE_DOMAINS = [
  "fragrantica.com",
  "parfumo.com",
  "basenotes.com",
  "luckyscent.com",
];

/**
 * The lane is live only when explicitly enabled AND an OpenRouter key exists.
 * Default OFF: shipping the tool before the key/flag are set is a silent no-op
 * (the agent simply answers from the catalog), never a hard failure.
 */
export function isResearchEnabled(): boolean {
  if (!process.env.OPENROUTER_API_KEY) return false;
  const flag = process.env.BEAM_RESEARCH_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

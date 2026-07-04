/**
 * Maps wardrobe clarify solver IDs → Serper query shaping + Poof hints.
 * Spec: artifacts/api-server/docs/scent-trunk-image-pipeline-edge-cases.md
 */

export type SerperRefineMode = "default" | "solver" | "none";

/** Poof removal mode when supported by API (Edge cases 6 / 8). */
export type PoofProductType = "auto" | "product";

export const IMAGE_SOLVER_IDS = [
  "low_contrast",
  "box_interference",
  "group_shot",
  "watermark",
  "transparent_glass",
  "tester_bottle",
  "hand_interference",
  "studio_reflection",
  "liquid_splash",
  "gift_set",
  "orientation",
  "refill_format",
  "text_overlay",
  "dupe_interference",
  "decant",
  "cropped_image",
  "niche_scraping",
  "manual_fallback",
] as const;

export type ImageSolverId = (typeof IMAGE_SOLVER_IDS)[number];

const SOLVER_ID_SET = new Set<string>(IMAGE_SOLVER_IDS);

/**
 * Solver ids that used to exist but were removed because they were guaranteed
 * end-to-end no-ops (image selection audit Tier 3 #11):
 *   - `abstract_query`: phase-2 "LLM parses free text" stub that was never
 *     built — it sent the unchanged default query and was never even offered
 *     in the dropdown.
 *   - `dark_edge_bleed`: documented as a "frontend rendering tweak; search
 *     unchanged", but no frontend handling was ever implemented — picking it
 *     was byte-for-byte identical to a plain refresh.
 * Stale clients may still send these ids; the refresh route treats them as a
 * plain default refresh instead of rejecting with 400.
 */
const LEGACY_SOLVER_ID_SET = new Set<string>(["abstract_query", "dark_edge_bleed"]);

export function isImageSolverId(value: unknown): value is ImageSolverId {
  return typeof value === "string" && SOLVER_ID_SET.has(value);
}

export function isLegacyImageSolverId(value: unknown): boolean {
  return typeof value === "string" && LEGACY_SOLVER_ID_SET.has(value);
}

export function buildBaseFragranceLine(asciiBrand: string, asciiName: string, concentrationText: string): string {
  return [asciiBrand, asciiName, concentrationText].filter(Boolean).join(" ").trim();
}

export type RefreshSerperInput = { query: string; refine: SerperRefineMode };

/**
 * Merge policy: solver-specific tokens are appended after the base fragrance line.
 * Serper refine mode: `default` = full packshot suffix (see serperService); `solver` = shorter suffix
 * so negative keywords are not drowned by repeated "no box" style tokens; `none` = send query as-is after trim.
 *
 * The refinement suffix itself is owned by ONE layer — serperService's
 * applySerperRefinement. Returning the bare fragrance line with `refine:
 * "default"` (instead of pre-appending a route-level suffix that the Serper
 * layer then suffixes AGAIN) keeps the composed query inside Google's 32-word
 * limit; the old double suffix pushed refresh queries to ~74 words, silently
 * truncating every refinement token past word 32.
 */
export function resolveRefreshSerperInput(params: {
  asciiBrand: string;
  asciiName: string;
  concentrationText: string;
  solverId?: ImageSolverId;
}): RefreshSerperInput {
  const baseLine = buildBaseFragranceLine(params.asciiBrand, params.asciiName, params.concentrationText);
  const qDefault = baseLine;

  if (!params.solverId) {
    return { query: qDefault, refine: "default" };
  }

  switch (params.solverId) {
    case "manual_fallback":
      return { query: qDefault, refine: "default" };
    case "transparent_glass":
      return { query: qDefault, refine: "default" };
    case "dupe_interference":
      // No exact-phrase `"{brand} {name}"`: page titles style names differently
      // ("Sauvage by Dior", "Dior — Sauvage EDP") so the quoted phrase returned
      // near-zero image results (audit S4). Loose tokens + clone negatives keep
      // the intent (exclude dupe/inspired listings) while matching real titles.
      return {
        query: `${baseLine} original -inspired -clone -type -impression -dupe`.trim(),
        refine: "solver",
      };
    case "niche_scraping":
      return {
        query: `${baseLine} site:fragrantica.com OR site:sephora.com`.trim(),
        refine: "none",
      };
    case "low_contrast":
      return { query: `${baseLine} bottle "dark background" OR "black background" -white -sample -tester`.trim(), refine: "solver" };
    case "box_interference":
      return { query: `${baseLine} -box -boxed -carton -packaging -sealed -gift -set glass bottle`.trim(), refine: "solver" };
    case "group_shot":
      return { query: `${baseLine} single bottle isolated`.trim(), refine: "solver" };
    case "watermark":
      return { query: `${baseLine} -stock -watermark -alamy -getty`.trim(), refine: "solver" };
    case "tester_bottle":
      return { query: `${baseLine} -tester -"tester 2" -sample -vial -decant "with cap"`.trim(), refine: "solver" };
    case "hand_interference":
      return { query: `${baseLine} -hand -holding`.trim(), refine: "solver" };
    case "studio_reflection":
      return { query: `${baseLine} matte lighting OR white studio background -mirror`.trim(), refine: "solver" };
    case "liquid_splash":
      return { query: `${baseLine} -splash -water -drops -floating`.trim(), refine: "solver" };
    case "gift_set":
      return { query: `${baseLine} -set -lotion -wash -bundle -gift`.trim(), refine: "solver" };
    case "orientation":
      // Loosened from requiring BOTH exact phrases "standing upright" AND
      // "front profile" in the document — that conjunction returned near-zero
      // image results (audit S4). Plain positive tokens plus negatives for the
      // tilted/lying shots the solver is trying to escape.
      return { query: `${baseLine} bottle upright front view -tilted -lying -sideways`.trim(), refine: "solver" };
    case "refill_format":
      return { query: `${baseLine} -refill -travel -vial -canister -pouch`.trim(), refine: "solver" };
    case "text_overlay":
      return { query: `${baseLine} -ad -poster -text -promotional -banner -watermark -sample -tester`.trim(), refine: "solver" };
    case "decant":
      // No `-ml` here: retail listing titles almost always contain "ml", so
      // negating it excluded practically the entire legitimate SERP.
      return { query: `${baseLine} -decant -sample -vial -travel -mini -split`.trim(), refine: "solver" };
    case "cropped_image":
      // Unquoted: the exact phrase "full bottle" rarely appears verbatim in
      // listing titles (audit S4); loose tokens keep the intent (whole bottle,
      // not a cap/nozzle macro) without demanding the literal phrase.
      return { query: `${baseLine} full bottle -macro -closeup -cropped`.trim(), refine: "solver" };
    default: {
      const _exhaustive: never = params.solverId;
      return _exhaustive;
    }
  }
}

export function solverWantsPoofProductType(solverId?: ImageSolverId): PoofProductType | undefined {
  if (solverId === "transparent_glass" || solverId === "hand_interference") return "product";
  return undefined;
}

export function solverSkipsBgRemoval(solverId?: ImageSolverId): boolean {
  return solverId === "manual_fallback";
}

/**
 * True when picking this solver means "the current picture is the WRONG picture
 * — find me a different one". The refresh route then excludes the candidate
 * whose source URL produced the currently stored image, so the pipeline cannot
 * hand back the identical cached WebP and look like a no-op (audit S2).
 *
 * False for the solvers that mean "the picture is right but its PROCESSING is
 * wrong" (re-run the same source with different Poof/trim settings):
 * transparent_glass (glass erased by bg removal), manual_fallback (skip AI
 * trim). No solver (plain refresh via API) keeps legacy behavior: no exclusion.
 */
export function solverPrefersDifferentImage(solverId?: ImageSolverId): boolean {
  if (!solverId) return false;
  switch (solverId) {
    case "transparent_glass":
    case "manual_fallback":
      return false;
    default:
      return true;
  }
}

/**
 * True when the solver's whole point is to RE-PROCESS a source with different
 * background-removal settings. For these, the pipeline must bypass the
 * per-source processed cache — otherwise the previously stored cut-out is
 * returned untouched and the new processing options never run (audit S2's
 * "guaranteed no-op" class):
 *   - transparent_glass / hand_interference: re-run Poof in `product` mode.
 *   - manual_fallback: skip bg removal entirely — but `acceptsImageCacheForRequest`
 *     accepts ANY cached variant when removal is not requested, so without the
 *     bypass the same trimmed cut-out the user is trying to escape is served
 *     right back instead of the raw image.
 */
export function solverWantsFreshProcessing(solverId?: ImageSolverId): boolean {
  return solverId === "transparent_glass" || solverId === "hand_interference" || solverId === "manual_fallback";
}

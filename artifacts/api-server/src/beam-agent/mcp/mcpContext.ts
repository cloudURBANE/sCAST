/**
 * Beam Agent — MCP request context + scope→tool mapping (plan §14).
 *
 * Pure (no SDK / DB / HTTP imports) so the security-relevant pieces — which tools
 * a token may see, and how a run context is derived — are unit-testable. The MCP
 * adapter (`beamMcpServer.ts`) calls into here; it never reimplements scope logic.
 */
import { randomUUID } from "node:crypto";
import type { BeamRunContext } from "../types.ts";
import type { BeamScope, DelegationClaims } from "./delegationToken.ts";

/** Every read scope an owner token should carry. */
export const ALL_READ_SCOPES: BeamScope[] = [
  "beam:user-context:read",
  "beam:wardrobe:read",
  "beam:catalog:read",
  "beam:details:read",
  "beam:score:read",
  "beam:overlap:read",
  "beam:research:read",
  "beam:present:read",
];

/**
 * Which tool names each scope unlocks. The MCP server lists/forwards ONLY tools
 * whose name is unlocked by the presented token, so a narrower token (e.g. a
 * future per-run token without `details:read`) automatically hides that tool.
 */
export const SCOPE_TOOL_MAP: Record<BeamScope, readonly string[]> = {
  "beam:user-context:read": ["beam_get_user_context"],
  "beam:wardrobe:read": ["beam_get_wardrobe"],
  // `beam_find_similar` ("smells like X") and `beam_discover_external` (hybrid-
  // corpus engine discovery) are catalog-scoped reads. find_similar is built when
  // `resolveCatalogEntry` is wired (always, on MCP); discover_external only when
  // `discoverExternal` is wired (BEAM_DISCOVER_EXTERNAL_ENABLED) — when off it is
  // never built, so listing it here is harmless (the server lists built ∩ allowed).
  "beam:catalog:read": ["beam_search_catalog", "beam_find_similar", "beam_discover_external"],
  // `beam_check_enrichment_state` is built only when `checkEnrichmentState` is
  // wired (always, on MCP). It's a read-only enrichment-state probe (cheap cached
  // engine state), so it rides the same details-read scope as fragrance details.
  "beam:details:read": ["beam_get_fragrance_details", "beam_check_enrichment_state"],
  "beam:score:read": ["beam_score_candidates"],
  // The MCP service wires `searchCatalog` (always) and `researchWeb` (see
  // beamServiceDeps), so createBeamTools builds these two tools on every request.
  // They must be scope-mapped here or the server filters them out as
  // "not permitted" even though they exist. beam_research_web stays inert
  // (returns a `note`) until BEAM_RESEARCH_ENABLED + OPENROUTER_API_KEY are set.
  "beam:overlap:read": ["beam_compare_overlap"],
  "beam:research:read": ["beam_research_web"],
  // Catalog-resolution + presentation tools. Built only when the MCP service
  // wires `resolveCatalogEntry` (see beamServiceDeps); read-only (the proposal/
  // kit "new" lane is add-ready but never written without the user's Confirm).
  "beam:present:read": [
    "beam_propose_collection",
    "beam_show_scent_profile",
    "beam_compare_fragrances",
    "beam_present_travel_kit",
  ],
};

/** Resolve the set of tool names a set of scopes is allowed to use. */
export function allowedToolNames(scopes: readonly BeamScope[]): Set<string> {
  const names = new Set<string>();
  for (const scope of scopes) {
    const tools = SCOPE_TOOL_MAP[scope];
    if (tools) for (const name of tools) names.add(name);
  }
  return names;
}

/**
 * Extract a bearer token from an Authorization header value. Returns null when
 * the header is absent or not a well-formed `Bearer <token>`.
 */
export function parseBearer(authHeader: string | undefined | null): string | null {
  if (typeof authHeader !== "string") return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Derive the per-call run context from verified claims. tenant/user come ONLY
 * from the signed token — never from tool arguments. A fresh runId/sessionId is
 * generated when the token doesn't carry one (owner/dev mode).
 */
export function deriveRunContext(claims: DelegationClaims): BeamRunContext {
  return {
    runId: claims.runId ?? `run_${randomUUID()}`,
    sessionId: claims.jti ? `beam_${claims.jti}` : `beam_${randomUUID()}`,
    tenantId: claims.tenantId,
    userId: claims.sub,
  };
}

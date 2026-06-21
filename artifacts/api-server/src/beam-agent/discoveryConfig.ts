/**
 * Beam Agent — external-discovery feature gating + spend caps.
 *
 * `beam_discover_external` reaches the paid engine/Decodo egress, so it is OPT-IN
 * per environment (like `BEAM_RESEARCH_ENABLED` gates web research). Both the
 * in-process route and the MCP service consult these, so the tool appears/behaves
 * identically across surfaces. Pure env reads — no I/O — safe to call per request.
 */

/** A truthy env flag in the usual `1|true|yes|on` family. */
function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

/**
 * Is external discovery turned on for THIS environment? Off by default so lean /
 * local / test deploys never reach the paid engine, and the tool is simply not
 * exposed until an operator opts in.
 */
export function isDiscoverExternalEnabled(): boolean {
  return envFlag(process.env.BEAM_DISCOVER_EXTERNAL_ENABLED);
}

/**
 * HARD per-RUN ceiling on external `/details` (Decodo-egress) fetches, summed
 * across every `beam_discover_external` call in one agent run. The per-CALL cap
 * (`BEAM_LIMITS.maxExternalDetailFetch`) is the inner bound; this is the outer
 * one the route enforces so a multi-call run can't multiply the spend.
 */
export function externalDetailRunCap(): number {
  const raw = Number(process.env.BEAM_EXTERNAL_DETAIL_RUN_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

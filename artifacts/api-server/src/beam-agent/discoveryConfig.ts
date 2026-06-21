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

/** An explicitly-falsey env flag in the usual `0|false|no|off` family. */
function envDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value ?? "").trim());
}

/**
 * Is external discovery turned on for THIS environment?
 *
 * ON by default: `beam_discover_external` is the ONLY tool that reaches the live
 * fragrance engine's search + `/details` enrichment, so leaving it off meant the
 * agent could only ever return thin local-catalog names and never fetched real
 * Fragrantica/Basenotes data — the "links but no data" defect. Spend stays bounded
 * by the per-call (`BEAM_LIMITS.maxExternalResults` / `maxExternalDetailFetch`) and
 * per-run (`externalDetailRunCap`) caps. Operators can still hard-disable it for a
 * lean/offline deploy with `BEAM_DISCOVER_EXTERNAL_ENABLED=false|0|off`.
 */
export function isDiscoverExternalEnabled(): boolean {
  const raw = process.env.BEAM_DISCOVER_EXTERNAL_ENABLED;
  if (envDisabled(raw)) return false;
  // Unset OR truthy → enabled.
  return true;
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

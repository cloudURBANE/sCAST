/**
 * Beam Agent — pure tool/runtime helpers.
 *
 * Everything here is PURE (no DB, no network, no workspace imports) so it can be
 * unit-tested in isolation with `node --experimental-strip-types --test`. The
 * DB/service-coupled tool bodies live in `beamTools.ts` and build on these.
 */
import type {
  BeamRunEvent,
  BeamToolDefinition,
  CandidatePacket,
  ClaudeContentBlock,
  ClaudeToolUseBlock,
} from "./types.ts";

/**
 * Hard ceilings the SERVER enforces — never trust a model-supplied limit. The
 * model can ask for 1000 results; it gets at most `maxCatalogResults`.
 */
export const BEAM_LIMITS = {
  maxCatalogResults: 12,
  maxDetailNames: 10,
  maxAgentTurns: 8,
  maxUserMessageLength: 2000,
  maxToolResultChars: 100_000,
  /** Agent-offered tap chips: how many, and the max label length. */
  maxSuggestions: 4,
  maxSuggestionLabel: 48,
} as const;

export function clampLimit(value: unknown, max: number, fallback = max): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(n, max));
}

export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

export function cleanStringList(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const t = entry.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.slice(0, 120));
    if (out.length >= max) break;
  }
  return out;
}

function numOrStr(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Claude response parsing                                             */
/* ------------------------------------------------------------------ */

/** Extract tool_use blocks from a Claude response content array. */
export function extractToolUses(content: ClaudeContentBlock[]): ClaudeToolUseBlock[] {
  return content.filter((block): block is ClaudeToolUseBlock => block.type === "tool_use");
}

/**
 * Sentinel a provider sets as a tool_use's `input` when the model emitted
 * arguments that are not valid JSON. The loop detects it and returns an explicit
 * tool ERROR (is_error) instead of running the handler on `{}` — so the model
 * retries with corrected args rather than misreading a coerced-empty result as
 * "nothing exists." Only the OpenRouter adapter parses arg strings; the
 * Anthropic-direct API already delivers structured tool input.
 */
const INVALID_ARGS_KEY = "__beamInvalidArguments";

export function invalidArgsMarker(raw: string): { [INVALID_ARGS_KEY]: string } {
  return { [INVALID_ARGS_KEY]: raw.slice(0, 200) };
}

export function readInvalidArgs(input: unknown): string | null {
  if (input && typeof input === "object" && INVALID_ARGS_KEY in input) {
    const raw = (input as Record<string, unknown>)[INVALID_ARGS_KEY];
    return typeof raw === "string" ? raw : "";
  }
  return null;
}

/** Concatenate text blocks into the assistant's prose reply. */
export function extractText(content: ClaudeContentBlock[]): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      out += (block as { text: string }).text;
    }
  }
  return out.trim();
}

/* ------------------------------------------------------------------ */
/* Event redaction + summaries                                        */
/* ------------------------------------------------------------------ */

/**
 * Redact an internal event for the browser. We only pass through shapes that are
 * already client-safe; a `failed` event is reduced to a stable code + the
 * provided (already-safe) message, and anything unexpected collapses to a
 * generic status so internal detail can never leak through a new event type.
 */
export function redactEventForClient(event: BeamRunEvent): BeamRunEvent {
  switch (event.type) {
    case "status":
    case "message_delta":
    case "tool_started":
    case "tool_completed":
    case "completed":
      return event;
    case "suggestions":
      // Model-authored chips — re-clamp at the client boundary defensively.
      return { type: "suggestions", items: sanitizeSuggestions(event.items) };
    case "failed":
      return { type: "failed", code: event.code, message: event.message };
    default:
      return { type: "status", label: "Working" };
  }
}

/** Clamp model-authored chips to safe count/length and drop empties + dupes. */
export function sanitizeSuggestions(
  items: ReadonlyArray<{ label?: unknown; value?: unknown }>,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const label = asString(item?.label)?.slice(0, BEAM_LIMITS.maxSuggestionLabel);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const value = asString(item?.value)?.slice(0, BEAM_LIMITS.maxSuggestionLabel) ?? label;
    out.push({ label, value });
    if (out.length >= BEAM_LIMITS.maxSuggestions) break;
  }
  return out;
}

/**
 * Pull a trailing tap-chip block out of the agent's final answer. The model is
 * told to optionally end with a fenced ```cues block (one chip per line, or a
 * JSON array of strings) when its reply invites the user to choose. We strip
 * that block from the visible text and return the chips separately so the UI can
 * render them as buttons. Tolerant: a malformed/absent block yields no chips and
 * leaves the text untouched.
 */
export function extractAgentCues(text: string): { text: string; cues: string[] } {
  const fence = /\n*```+\s*cues\b[^\n]*\n([\s\S]*?)```+\s*$/i.exec(text);
  if (!fence) return { text: text.trim(), cues: [] };
  const inner = fence[1].trim();
  let raw: string[] = [];
  if (inner.startsWith("[")) {
    try {
      const parsed = JSON.parse(inner) as unknown;
      if (Array.isArray(parsed)) raw = parsed.map((v) => (typeof v === "string" ? v : String(v)));
    } catch {
      raw = [];
    }
  }
  if (raw.length === 0) {
    raw = inner.split(/\r?\n/).map((line) => line.replace(/^\s*[-*•]\s*/, "").trim());
  }
  const cues = sanitizeSuggestions(raw.map((label) => ({ label, value: label }))).map((c) => c.label);
  const cleaned = text.slice(0, fence.index).trim();
  return { text: cleaned, cues };
}

/** One-line human summary of a tool result for the `tool_completed` event. */
export function summarizeToolResult(_name: string, result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.sources)) {
      const n = record.sources.length;
      return record.synthesizedFact ? `researched (${n} source(s))` : "no live result";
    }
    // beam_get_user_context returns a nested vault summary. Surface the size +
    // dominant families so the progress line reads as grounded ("8 bottles ·
    // woody, amber") instead of a bare "done".
    if (record.wardrobeSummary && typeof record.wardrobeSummary === "object") {
      const ws = record.wardrobeSummary as { count?: unknown; topFamilies?: unknown };
      const count = typeof ws.count === "number" ? ws.count : 0;
      if (count <= 0) return "vault is empty";
      const families = Array.isArray(ws.topFamilies)
        ? ws.topFamilies.filter((f): f is string => typeof f === "string").slice(0, 2)
        : [];
      const noun = count === 1 ? "bottle" : "bottles";
      return families.length > 0 ? `${count} ${noun} · ${families.join(", ")}` : `${count} ${noun}`;
    }
    if (Array.isArray(record.items)) return `${record.items.length} result(s)`;
    if (Array.isArray(record.candidates)) return `${record.candidates.length} candidate(s)`;
    if (record.recommendation && typeof record.recommendation === "object") {
      const name = (record.recommendation as { canonicalName?: unknown; name?: unknown }).canonicalName
        ?? (record.recommendation as { name?: unknown }).name;
      return typeof name === "string" ? `picked ${name}` : "scored vault";
    }
    if (record.recommendation === null) return "no match";
    if (typeof record.count === "number") return `${record.count} item(s)`;
  }
  return "done";
}

/* ------------------------------------------------------------------ */
/* CandidatePacket builders                                           */
/* ------------------------------------------------------------------ */

/** Build a CandidatePacket from an owned wardrobe item (structural shape). */
export function packetFromOwnedItem(item: {
  id: string;
  name: string;
  brand?: string;
  families?: string[];
  accords?: string[];
  longevity?: number | string;
  sillage?: string;
}): CandidatePacket {
  const accords = cleanStringList([...(item.families ?? []), ...(item.accords ?? [])]);
  return {
    fragranceId: item.id,
    canonicalName: item.name,
    brand: item.brand ?? "",
    owned: true,
    notes: { top: [], middle: [], base: [] },
    accords,
    performance: { longevity: numOrStr(item.longevity), projection: numOrStr(item.sillage) },
    sourceConfidence: 0.95,
    missingFields: accords.length > 0 ? [] : ["accords"],
  };
}

/**
 * Build an owned-bottle CandidatePacket straight from a `user_fragrances` row's
 * raw JSONB, preserving the note pyramid (top/middle/base) that the mission
 * wardrobe shape collapses into a flat accord list. This is the richer evidence
 * the agent reasons over for owned bottles; falls back to `packetFromOwnedItem`
 * upstream when the raw row is unavailable. Returns null when the row has no name.
 */
export function packetFromWardrobeRow(rowId: string, fragranceData: unknown): CandidatePacket | null {
  if (typeof fragranceData !== "object" || fragranceData === null) return null;
  const data = fragranceData as Record<string, any>;
  const name = asString(data.name) ?? asString(data.product?.name);
  if (!name) return null;

  const brand = asString(data.brand) ?? asString(data.product?.brand) ?? asString(data.house) ?? "";
  const pyramid = (typeof data.pyramid === "object" && data.pyramid !== null
    ? data.pyramid
    : {}) as Record<string, unknown>;
  const notes = {
    top: cleanStringList(pyramid.top),
    middle: cleanStringList(pyramid.middle ?? pyramid.heart),
    base: cleanStringList(pyramid.base),
  };
  const accords = cleanStringList(
    data.accords ?? data.family ?? data.families ?? data.scent_families ?? data.notes,
  );
  const noteCount = notes.top.length + notes.middle.length + notes.base.length;
  const missing: string[] = [];
  if (noteCount === 0) missing.push("notes");
  if (accords.length === 0) missing.push("accords");

  return {
    fragranceId: asString(data.id) ?? rowId,
    canonicalName: name,
    brand,
    owned: true,
    notes,
    accords,
    performance: {
      longevity: numOrStr(data.longevity ?? data.performance?.longevity),
      projection: numOrStr(data.sillage ?? data.performance?.sillage),
    },
    sourceConfidence: missing.length === 0 ? 0.95 : Math.max(0.4, 0.95 - missing.length * 0.15),
    missingFields: missing,
  };
}

/**
 * Build a CandidatePacket from a flattened catalog profile. The shape of a
 * flattened `global_fragrances` profile is loosely typed, so we read every field
 * defensively and record what is missing rather than trusting it.
 */
export function packetFromFlatProfile(
  fragranceId: string,
  flat: Record<string, unknown>,
  owned: boolean,
): CandidatePacket {
  const name = asString(flat.name) ?? asString((flat.product as Record<string, unknown> | undefined)?.name) ?? "";
  const brand = asString(flat.brand) ?? asString(flat.house) ?? "";
  const pyramid = (typeof flat.pyramid === "object" && flat.pyramid !== null
    ? (flat.pyramid as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const notes = {
    top: cleanStringList(pyramid.top),
    middle: cleanStringList(pyramid.middle ?? pyramid.heart),
    base: cleanStringList(pyramid.base),
  };
  const accords = cleanStringList(flat.accords ?? flat.families ?? flat.notes);
  const missing: string[] = [];
  if (!name) missing.push("name");
  if (!brand) missing.push("brand");
  if (notes.top.length + notes.middle.length + notes.base.length === 0) missing.push("notes");
  if (accords.length === 0) missing.push("accords");
  return {
    fragranceId,
    canonicalName: name,
    brand,
    owned,
    notes,
    accords,
    performance: {
      longevity: numOrStr(flat.longevity),
      projection: numOrStr(flat.sillage ?? flat.projection),
    },
    sourceConfidence: missing.length === 0 ? 0.9 : Math.max(0.3, 0.9 - missing.length * 0.15),
    missingFields: missing,
  };
}

/* ------------------------------------------------------------------ */
/* Claude tool-schema adapter                                         */
/* ------------------------------------------------------------------ */

/** Convert Beam tool definitions to the Claude Messages API `tools` array. */
export function toClaudeTools(
  defs: BeamToolDefinition[],
): Array<{ name: string; description: string; input_schema: BeamToolDefinition["inputSchema"] }> {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.inputSchema,
  }));
}

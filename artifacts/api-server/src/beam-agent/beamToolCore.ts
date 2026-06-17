/**
 * Beam Agent — pure tool/runtime helpers.
 *
 * Everything here is PURE (no DB, no network, no workspace imports) so it can be
 * unit-tested in isolation with `node --experimental-strip-types --test`. The
 * DB/service-coupled tool bodies live in `beamTools.ts` and build on these.
 */
import type {
  BeamCard,
  BeamCardFragrance,
  BeamProposalItem,
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
  /**
   * Hard backstop on a single tool result's serialized size in the TRANSCRIPT.
   * Lowered from 100_000: a result is re-sent on every subsequent model turn, so
   * one fat `beam_get_fragrance_details`/`beam_research_web` payload (~25k tokens)
   * used to dominate the synthesis call's input — the single biggest cost driver.
   * `boundToolResultForTranscript` does the record-aware shrinking first; this is
   * only the final char ceiling so a pathological result can't blow the budget.
   */
  maxToolResultChars: 12_000,
  /** Per-array item cap when bounding a tool result for the transcript. */
  maxToolResultArrayItems: 16,
  /**
   * Per-string char cap when bounding a tool result for the transcript. Set high
   * enough to keep answer-bearing prose intact (a `beam_research_web`
   * synthesizedFact, a scent description) while still cutting the multi-KB
   * Fragrantica detail/review blobs that drove the cost. ~250 tokens.
   */
  maxToolResultStringChars: 1000,
  /** Agent-offered tap chips: how many, and the max label length. */
  maxSuggestions: 4,
  maxSuggestionLabel: 48,
  /** Fragrances the agent may propose to add to the vault in one collection. */
  maxProposalItems: 5,
  /** UI-card bounds (notes/accords lists, kit lane sizes, caption length). */
  maxCardNotes: 8,
  maxCardAccords: 8,
  maxCardSharedItems: 8,
  maxKitPicks: 5,
  maxCardCaption: 180,
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
/* Tool-result transcript trimming                                    */
/* ------------------------------------------------------------------ */

/**
 * Bound a tool result for the TRANSCRIPT before it is serialized and re-sent on
 * every subsequent model turn. The full, untrimmed result is still used for
 * grounding, scoring, and UI cards (the loop passes the raw object there); this
 * only shapes what enters `messages`, so accumulated tool JSON doesn't dominate
 * the synthesis call's input — the dominant cost driver (a single details /
 * research payload can be ~25k tokens, re-billed on each turn).
 *
 * Record-aware, NOT a blind char slice: arrays are capped by COUNT and strings
 * by LENGTH, so the output is always structurally valid JSON (the model never
 * reads a record cut in half) and short identifying fields — names, brands,
 * accords — always survive intact. A dropped array tail leaves a small
 * `…+N more` marker so the model knows the list was longer; over-deep nesting
 * collapses to a placeholder rather than recursing without bound.
 *
 * Pure + deterministic; safe to unit test. Returns a fresh structure (never
 * mutates the input).
 */
export function boundToolResultForTranscript(
  value: unknown,
  opts?: { maxArrayItems?: number; maxStringChars?: number; maxDepth?: number },
): unknown {
  const maxArrayItems = opts?.maxArrayItems ?? BEAM_LIMITS.maxToolResultArrayItems;
  const maxStringChars = opts?.maxStringChars ?? BEAM_LIMITS.maxToolResultStringChars;
  const maxDepth = opts?.maxDepth ?? 6;

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      return v.length > maxStringChars ? `${v.slice(0, maxStringChars)}…` : v;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
    if (Array.isArray(v)) {
      if (depth >= maxDepth) return `[${v.length} items]`;
      const capped: unknown[] = v.slice(0, maxArrayItems).map((entry) => walk(entry, depth + 1));
      if (v.length > maxArrayItems) capped.push(`…+${v.length - maxArrayItems} more`);
      return capped;
    }
    if (v && typeof v === "object") {
      if (depth >= maxDepth) return "[object]";
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    // Drop functions/symbols/bigint — JSON.stringify would too (or throw on bigint).
    return undefined;
  };

  return walk(value, 0);
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
    case "proposal":
      // Items are server-resolved catalog data (safe), just clamp the count.
      return {
        type: "proposal",
        proposalId: event.proposalId,
        items: event.items.slice(0, BEAM_LIMITS.maxProposalItems),
      };
    case "card":
      // Card data is server-resolved from real records; clamp the unbounded
      // list/string fields defensively at the client boundary.
      return { type: "card", card: sanitizeCardForClient(event.card) };
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

/**
 * Pull the fragrance names a tool result actually GROUNDS — i.e. names that came
 * from real retrieved data (catalog hits, the user's vault, a deterministic
 * scoring pick, a resolved proposal), so the loop can constrain the final answer
 * to only name fragrances it actually retrieved. Conservative: a
 * `beam_get_fragrance_details` entry only grounds a name when `found !== false`
 * (the model supplied that name, so an un-found lookup must NOT ground it).
 * Returns deduped display strings; never throws on odd shapes.
 */
export function collectGroundedFragranceNames(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (value: unknown): void => {
    const name = asString(value);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  const fromEntry = (entry: unknown, requireFound: boolean): void => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    // A details entry carries { name, found }; only ground it when found.
    if (requireFound && e.found === false) return;
    add(e.canonicalName ?? e.name);
  };

  // beam_get_fragrance_details echoes the model's queried names — only grounded
  // when the lookup actually found facts.
  const detailItems = Array.isArray(record.items) && record.items.some(
    (it) => it && typeof it === "object" && "found" in (it as object),
  );
  for (const key of ["items", "picks", "proposed"] as const) {
    const arr = record[key];
    if (Array.isArray(arr)) for (const entry of arr) fromEntry(entry, key === "items" && detailItems);
  }
  if (record.recommendation && typeof record.recommendation === "object") {
    fromEntry(record.recommendation, false);
  }
  return out;
}

/**
 * Build an add-ready proposal item from a flattened catalog profile. Defensive:
 * pulls only known fields, normalizes lists, and returns null when there is no
 * usable name (so an unresolved/garbage record is dropped, never proposed).
 */
export function buildProposalItem(flat: Record<string, unknown>): BeamProposalItem | null {
  const name = asString(flat.name) ?? asString((flat.product as { name?: unknown })?.name);
  if (!name) return null;
  const brand =
    asString(flat.brand) ?? asString((flat.product as { brand?: unknown })?.brand) ?? "";

  const item: BeamProposalItem = {
    name,
    brand,
    notes: cleanStringList(flat.notes),
    accords: cleanStringList(flat.accords),
  };

  const family = asString(flat.family);
  if (family) item.family = family;

  if (flat.pyramid && typeof flat.pyramid === "object") {
    const p = flat.pyramid as Record<string, unknown>;
    item.pyramid = {
      top: cleanStringList(p.top),
      heart: cleanStringList(p.heart),
      base: cleanStringList(p.base),
    };
  }

  if (flat.scent_vector && typeof flat.scent_vector === "object") {
    const v = flat.scent_vector as Record<string, unknown>;
    const axis = (key: string): number => (typeof v[key] === "number" && Number.isFinite(v[key]) ? (v[key] as number) : 0);
    item.scentVector = {
      freshness: axis("freshness"),
      sweetness: axis("sweetness"),
      woodiness: axis("woodiness"),
      spice: axis("spice"),
      warmth: axis("warmth"),
      musk: axis("musk"),
    };
  }

  if (flat.performance && typeof flat.performance === "object") {
    const perf = flat.performance as Record<string, unknown>;
    const sillage = numOrStr(perf.sillage);
    const longevity = numOrStr(perf.longevity);
    if (sillage !== undefined || longevity !== undefined) item.performance = { sillage, longevity };
  }

  const concentration = asString(flat.concentration);
  if (concentration) item.concentration = concentration;
  const imageUrl = asString(flat.imageUrl);
  if (imageUrl) item.imageUrl = imageUrl;
  const storagePath = asString(flat.storagePath);
  if (storagePath) item.storagePath = storagePath;
  const imageHash = asString(flat.imageHash);
  if (imageHash) item.imageHash = imageHash;
  const storageProvider = asString(flat.storageProvider);
  if (storageProvider) item.storageProvider = storageProvider;
  const sourceProvider = asString(flat.sourceProvider);
  if (sourceProvider) item.sourceProvider = sourceProvider;
  const description = asString(flat.description);
  if (description) item.description = description.slice(0, 600);

  return item;
}

/* ------------------------------------------------------------------ */
/* UI card builders + redaction                                       */
/* ------------------------------------------------------------------ */

/**
 * Project an add-ready proposal item down to the `BeamCardFragrance` shape a UI
 * card renders. `owned` is supplied by the caller (verified against the vault),
 * never inferred here.
 */
export function cardFragranceFromProposalItem(item: BeamProposalItem, owned: boolean): BeamCardFragrance {
  const card: BeamCardFragrance = {
    name: item.name,
    brand: item.brand,
    accords: item.accords.slice(0, BEAM_LIMITS.maxCardAccords),
    owned,
  };
  if (item.family) card.family = item.family;
  if (item.scentVector) card.scentVector = item.scentVector;
  if (item.imageUrl) card.imageUrl = item.imageUrl;
  if (item.storagePath) card.storagePath = item.storagePath;
  if (item.imageHash) card.imageHash = item.imageHash;
  if (item.storageProvider) card.storageProvider = item.storageProvider;
  return card;
}

/** Clamp each axis of a scent vector into 0..1 (drops NaN/∞, rounds to 2dp). */
function sanitizeScentVector(v: BeamCardFragrance["scentVector"]): BeamCardFragrance["scentVector"] {
  if (!v) return undefined;
  const axis = (n: number): number => (Number.isFinite(n) ? round2(Math.min(1, Math.max(0, n))) : 0);
  return {
    freshness: axis(v.freshness),
    sweetness: axis(v.sweetness),
    woodiness: axis(v.woodiness),
    spice: axis(v.spice),
    warmth: axis(v.warmth),
    musk: axis(v.musk),
  };
}

function sanitizeCardFragrance(f: BeamCardFragrance): BeamCardFragrance {
  const out: BeamCardFragrance = {
    name: String(f.name ?? "").slice(0, 120),
    brand: String(f.brand ?? "").slice(0, 120),
    accords: cleanStringList(f.accords).slice(0, BEAM_LIMITS.maxCardAccords),
  };
  if (f.family) out.family = String(f.family).slice(0, 80);
  const vector = sanitizeScentVector(f.scentVector);
  if (vector) out.scentVector = vector;
  if (f.owned) out.owned = true;
  if (f.imageUrl) out.imageUrl = f.imageUrl;
  if (f.storagePath) out.storagePath = f.storagePath;
  if (f.imageHash) out.imageHash = f.imageHash;
  if (f.storageProvider) out.storageProvider = f.storageProvider;
  return out;
}

/**
 * Clamp an agent-emitted UI card at the client boundary. The data is already
 * server-resolved, so this only bounds list/string sizes (defense in depth) and
 * passes the shape through untouched otherwise.
 */
export function sanitizeCardForClient(card: BeamCard): BeamCard {
  switch (card.kind) {
    case "scent_profile": {
      const out: BeamCard = { kind: "scent_profile", fragrance: sanitizeCardFragrance(card.fragrance) };
      if (card.pyramid) {
        out.pyramid = {
          top: cleanStringList(card.pyramid.top).slice(0, BEAM_LIMITS.maxCardNotes),
          heart: cleanStringList(card.pyramid.heart).slice(0, BEAM_LIMITS.maxCardNotes),
          base: cleanStringList(card.pyramid.base).slice(0, BEAM_LIMITS.maxCardNotes),
        };
      }
      if (card.caption) out.caption = String(card.caption).slice(0, BEAM_LIMITS.maxCardCaption);
      return out;
    }
    case "compare":
      return {
        kind: "compare",
        a: sanitizeCardFragrance(card.a),
        b: sanitizeCardFragrance(card.b),
        overlapPercent: Number.isFinite(card.overlapPercent)
          ? Math.min(100, Math.max(0, Math.round(card.overlapPercent)))
          : 0,
        band: card.band,
        sharedNotes: cleanStringList(card.sharedNotes).slice(0, BEAM_LIMITS.maxCardSharedItems),
        sharedAccords: cleanStringList(card.sharedAccords).slice(0, BEAM_LIMITS.maxCardSharedItems),
        ...(card.verdict ? { verdict: String(card.verdict).slice(0, BEAM_LIMITS.maxCardCaption) } : {}),
      };
    case "travel_kit":
      return {
        kind: "travel_kit",
        ...(card.title ? { title: String(card.title).slice(0, 120) } : {}),
        ownedPicks: card.ownedPicks.slice(0, BEAM_LIMITS.maxKitPicks).map(sanitizeCardFragrance),
        newPicks: card.newPicks.slice(0, BEAM_LIMITS.maxKitPicks),
        ...(card.proposalId ? { proposalId: card.proposalId } : {}),
      };
    default:
      return card;
  }
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
/* Wardrobe overlap (redundancy radar) — pure, deterministic          */
/* ------------------------------------------------------------------ */

/** Normalized note/accord sets a candidate or owned bottle exposes for overlap. */
export type OverlapProfile = {
  top: string[];
  middle: string[];
  base: string[];
  accords: string[];
};

export type OverlapBand = "high" | "moderate" | "some" | "low";

export type OverlapBreakdown = {
  /** 0..1 Jaccard similarity per facet. */
  base: number;
  heart: number;
  top: number;
  accords: number;
  /** 0..1 weighted blend; drydown (base) and accords dominate. */
  combined: number;
  band: OverlapBand;
  /** Notes/accords present in BOTH sides (original casing, deduped). */
  sharedBaseNotes: string[];
  sharedAccords: string[];
};

/** Lowercase + trim + dedupe a string list into a set for set math. */
function normSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const t = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (t) out.add(t);
  }
  return out;
}

/**
 * Jaccard similarity |A∩B| / |A∪B|. Two empty sets return 0 (absence of
 * evidence is NOT a claim of identity), and an empty vs non-empty set is 0.
 */
export function jaccard(a: string[], b: string[]): number {
  const A = normSet(a);
  const B = normSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Items appearing in both lists, returned with `a`'s original casing, deduped. */
function sharedItems(a: string[], b: string[]): string[] {
  const B = normSet(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of a) {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (!t) continue;
    const key = t.toLowerCase();
    if (B.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function overlapBand(combined: number): OverlapBand {
  if (combined >= 0.6) return "high";
  if (combined >= 0.35) return "moderate";
  if (combined >= 0.15) return "some";
  return "low";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Deterministic redundancy score between a candidate fragrance and ONE owned
 * bottle. Weighting reflects fragrance structure: base notes carry the lasting
 * drydown/trail (what makes two scents "feel the same"), accords capture the
 * overall family/character, the heart shapes the mid, and volatile top notes
 * barely matter for redundancy. When neither side carries a note pyramid we
 * fall back to accords alone rather than inventing a number.
 *
 * This is a likelihood that two bottles occupy the same wardrobe slot — NOT a
 * claim that they share an identical formula.
 */
export function computeOverlap(candidate: OverlapProfile, owned: OverlapProfile): OverlapBreakdown {
  const base = jaccard(candidate.base, owned.base);
  const heart = jaccard(candidate.middle, owned.middle);
  const top = jaccard(candidate.top, owned.top);
  const accords = jaccard(candidate.accords, owned.accords);

  const candidateHasNotes = candidate.base.length + candidate.middle.length + candidate.top.length > 0;
  const ownedHasNotes = owned.base.length + owned.middle.length + owned.top.length > 0;
  const hasNotes = candidateHasNotes && ownedHasNotes;

  const combined = hasNotes ? 0.45 * base + 0.2 * heart + 0.05 * top + 0.3 * accords : accords;

  return {
    base: round2(base),
    heart: round2(heart),
    top: round2(top),
    accords: round2(accords),
    combined: round2(combined),
    band: overlapBand(combined),
    sharedBaseNotes: sharedItems(candidate.base, owned.base),
    sharedAccords: sharedItems(candidate.accords, owned.accords),
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

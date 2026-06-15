import type { ScentMissionWeather } from '@workspace/scent-weather-engine';

/**
 * Browser client for the live Beam Agent (read-only, Phase 1).
 *
 * Talks to the SSE surface in api-server `beam-agent/beamAgentRoutes.ts`:
 *   POST /api/beam-agent/runs            → { runId, sessionId, eventsUrl }
 *   GET  /api/beam-agent/runs/:id/events → text/event-stream of progress events
 *
 * Native `EventSource` cannot send an `Authorization` header, and `requireAuth`
 * reads the bearer token only from that header — so we consume the stream with
 * `fetch` + a hand-rolled `data: …\n\n` frame reader instead of adding a dep.
 * Unlike `scentMissionClient.ts` this module touches `fetch`/streams, so it is
 * browser-only (not run under the node test runner).
 */

/**
 * The only event shapes the server emits to clients (already passed through
 * `redactEventForClient` on the backend). Mirrors `beam-agent/types.ts`.
 */
/** A tap-to-answer chip the agent offers with its reply. */
export type BeamSuggestion = { label: string; value: string };

/**
 * An add-ready fragrance the agent proposes for the vault (resolved from the
 * catalog server-side). Mirrors `BeamProposalItem` in the api-server types and
 * is shaped to drop into the app's normal wardrobe-add path.
 */
export type BeamProposalItem = {
  name: string;
  brand: string;
  family?: string;
  notes: string[];
  pyramid?: { top: string[]; heart: string[]; base: string[] };
  accords: string[];
  scentVector?: {
    freshness: number;
    sweetness: number;
    woodiness: number;
    spice: number;
    warmth: number;
    musk: number;
  };
  performance?: { sillage?: number | string; longevity?: number | string };
  concentration?: string;
  imageUrl?: string;
  storagePath?: string;
  imageHash?: string;
  storageProvider?: string;
  sourceProvider?: string;
  description?: string;
};

export type BeamAgentEvent =
  | { type: 'status'; label: string }
  | { type: 'message_delta'; text: string }
  | { type: 'tool_started'; tool: string }
  | { type: 'tool_completed'; tool: string; summary: string }
  | { type: 'suggestions'; items: BeamSuggestion[] }
  | { type: 'proposal'; proposalId: string; items: BeamProposalItem[] }
  | { type: 'completed'; response: string }
  | { type: 'failed'; code: string; message: string };

/** Terminal outcome of a run — `completed` with text, or `failed` with a code. */
export type BeamAgentRunResult =
  | { status: 'completed'; response: string; sessionId: string }
  | { status: 'failed'; code: string; message: string; sessionId: string };

export type RunBeamAgentOptions = {
  /** The user's turn (required, trimmed/≤2000 chars enforced server-side). */
  message: string;
  /** Carry the conversation's session id so the agent keeps context. */
  sessionId?: string;
  /** Optional weather context, sanitized again server-side. */
  weather?: ScentMissionWeather;
  /** Opaque per-user token (`localStorage["scent_token"]`). Required. */
  authToken: string;
  /** Base URL for the Express API; empty string = same origin. */
  apiBaseUrl?: string;
  /** Optional OpenRouter slug override. */
  model?: string;
  /** Abort the POST and the SSE stream (supersede / timeout / unmount). */
  signal?: AbortSignal;
  /** Live progress events for the thinking note (status / tool_* / etc.). */
  onEvent?: (event: BeamAgentEvent) => void;
};

/** Thrown when the run cannot start or the stream fails at the HTTP level. */
export class BeamAgentError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BeamAgentError';
    this.status = status;
  }
}

type StartRunResponse = { runId: string; sessionId: string; eventsUrl: string };

// Concierge-voiced progress copy. These read as a person curating, not a tool
// loop — "Reading your calibration" / "Searching the catalog" exposed the
// machinery underneath the luxury surface and made the wait read like a debug
// log. We keep the phrasing warm, first-person about *you*, and never imply a
// raw search that might come back empty.
const TOOL_LABELS: Record<string, string> = {
  beam_get_user_context: 'Reading your taste profile…',
  beam_get_wardrobe: 'Looking through your vault…',
  beam_search_catalog: 'Considering more fragrances for you…',
  beam_get_fragrance_details: 'Studying the composition…',
  beam_score_candidates: 'Scoring your vault against tonight…',
  beam_compare_overlap: 'Seeing what already lives in your vault…',
  beam_research_web: 'Cross-checking the notes…',
  beam_propose_collection: 'Lining up your picks…',
};

/** Humanize a `beam_*` tool name into a progress-note phrase. */
export function humanizeBeamTool(tool: string): string {
  return TOOL_LABELS[tool] ?? 'Working on it…';
}

/** Parse one SSE frame (lines split by `\n`) into an event, or null to skip. */
function parseEventFrame(frame: string): BeamAgentEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as BeamAgentEvent;
    }
  } catch {
    // A malformed frame (e.g. a keep-alive comment) just yields no event.
  }
  return null;
}

/**
 * Start a Beam Agent run and consume its SSE progress stream to completion.
 * Resolves with the terminal `completed`/`failed` result. Throws
 * `BeamAgentError` if the run cannot start or the stream fails at HTTP level,
 * and rethrows `AbortError` when the caller's signal aborts.
 */
export async function runBeamAgentMission(options: RunBeamAgentOptions): Promise<BeamAgentRunResult> {
  const base = (options.apiBaseUrl ?? '').replace(/\/+$/, '');
  const authHeader = { Authorization: `Bearer ${options.authToken}` };

  const startRes = await fetch(`${base}/api/beam-agent/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    signal: options.signal,
    body: JSON.stringify({
      message: options.message,
      sessionId: options.sessionId,
      uiContext: options.weather ? { weather: options.weather } : undefined,
      model: options.model,
    }),
  });
  if (!startRes.ok) {
    throw new BeamAgentError(`Beam Agent run could not start (${startRes.status}).`, startRes.status);
  }
  const start = (await startRes.json()) as StartRunResponse;

  const streamRes = await fetch(`${base}${start.eventsUrl}`, {
    headers: authHeader,
    signal: options.signal,
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new BeamAgentError(`Beam Agent stream failed (${streamRes.status}).`, streamRes.status);
  }

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseEventFrame(frame);
        if (!event) continue;
        options.onEvent?.(event);
        if (event.type === 'completed') {
          return { status: 'completed', response: event.response, sessionId: start.sessionId };
        }
        if (event.type === 'failed') {
          return { status: 'failed', code: event.code, message: event.message, sessionId: start.sessionId };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // Cancelling an already-aborted/closed stream is fine to ignore.
    });
  }

  // The backend always ends the stream after a completed/failed frame, so
  // reaching here means the connection dropped early — treat as a soft failure
  // the caller can fall back from.
  throw new BeamAgentError('Beam Agent stream ended without a result.');
}

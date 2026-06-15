# 06 — Part 2 handoff: wire the frontend to the live Beam Agent

**Status:** PR1 (backend on OpenRouter) is merged-ready on branch
`feat/beam-agent-openrouter` (pushed). This doc is the spec for **PR2: connect
`ScentMissionPanel.tsx` to the agent's SSE endpoints** so authenticated users
actually reach the tool-calling agent. Written 2026-06-14 against the real code
PR1 shipped — every path/contract below was verified in the source.

> **Why a Part 2 at all:** PR1 deliberately stopped at the backend. Today the
> panel only contains a cosmetic `key={busy ? 'beam-agent-thinking' : ...}`
> string ([ScentMissionPanel.tsx:806](../../artifacts/scent-cast/src/components/ScentMissionPanel.tsx#L806)).
> Nothing in the UI calls `/api/beam-agent`. Until PR2 lands, the agent is mounted
> but unreachable from the browser.

---

## 1. What PR1 already did (don't redo or change these)

- **Mounted** the router: `mountBeamAgent(app)` in
  [app.ts](../../artifacts/api-server/src/app.ts) → routes live at `/api/beam-agent`.
- **Provider is OpenRouter** by default. [provider.ts](../../artifacts/api-server/src/beam-agent/provider.ts)
  picks OpenRouter when `OPENROUTER_API_KEY` is set, else Anthropic-direct, else a
  graceful `model_unavailable` event. [openRouterProvider.ts](../../artifacts/api-server/src/beam-agent/openRouterProvider.ts)
  adapts OpenAI ↔ the loop's Anthropic block shape. **Backend HTTP/SSE contract is
  final — PR2 is frontend-only.** Do not edit the loop, tools, routes, or provider.
- Verified: typecheck clean, 300/300 api-server tests, builds OK.

**Ops prerequisite (owner, not code):** `OPENROUTER_API_KEY` must be set in the
**deployed** api-server env or every run returns `failed/model_unavailable`.

---

## 2. The exact backend contract (source of truth: [beamAgentRoutes.ts](../../artifacts/api-server/src/beam-agent/beamAgentRoutes.ts))

All three routes require `Authorization: Bearer <users.token>` (the opaque uuid in
`localStorage["scent_token"]` — same token the existing `/api/scent-mission` fetch
already sends as `authToken`). `POST /runs` is rate-limited 20 / 5 min / IP.

**1. Start a run** — `POST /api/beam-agent/runs`
```jsonc
// request body
{
  "message": "what should I wear for a hot humid day?",  // required, trimmed, ≤2000 chars
  "sessionId": "beam_…",                                  // optional; server mints if absent
  "uiContext": { "weather": { /* ScentMissionWeather */ } }, // optional; sanitized server-side
  "model": "anthropic/claude-haiku-4.5"                   // optional OpenRouter slug override
}
// 202 response
{ "runId": "run_…", "sessionId": "beam_…", "eventsUrl": "/api/beam-agent/runs/<runId>/events" }
```
400 if `message` missing; 401 if unauthenticated. The run starts immediately
(fire-and-forget); the client consumes progress over SSE.

**2. Stream progress** — `GET /api/beam-agent/runs/:runId/events` (SSE).
Replays any buffered events, then streams live; **ownership is enforced**
(userId + tenantId must match the run, else 403/404). Closes the stream after a
`completed` or `failed` event. Each frame is `data: <JSON>\n\n`.

**3. Stop** — `POST /api/beam-agent/runs/:runId/stop` (cooperative; sets a flag).

**Client-safe event types** (from [types.ts](../../artifacts/api-server/src/beam-agent/types.ts),
filtered through `redactEventForClient` — these are the ONLY shapes you'll receive):
```ts
| { type: "status";         label: string }            // "Understanding your request", …
| { type: "message_delta";  text: string }             // streamed synthesis text (loop now emits this)
| { type: "tool_started";   tool: BeamToolName }        // e.g. "beam_search_catalog"
| { type: "tool_completed"; tool: BeamToolName; summary: string } // e.g. "12 candidate(s)"
| { type: "suggestions";    items: string[] }           // follow-up chips
| { type: "proposal";       proposalId: string; items: BeamProposalItem[] } // signature-pick reveal
| { type: "completed";      response: string }          // FINAL free-text answer
| { type: "failed";         code: string; message: string }
```
`code` values you must handle: `model_unavailable` (no key configured),
`max_turns`, `stopped`, `agent_error`.

---

## 3. THE gotcha: native `EventSource` cannot be used

`requireAuth` reads the token **only** from the `Authorization` header
([auth.ts:13-14](../../artifacts/api-server/src/middlewares/auth.ts#L13-L14)). The
browser `EventSource` API **cannot set request headers**. So:

- **Do not** use `new EventSource(eventsUrl)`.
- **Do** consume the SSE with `fetch(eventsUrl, { headers: { Authorization } })`
  and read `res.body.getReader()` as a stream, parsing `data: …\n\n` frames
  yourself, **or** add the small `@microsoft/fetch-event-source` dep (supports
  headers). A hand-rolled reader (~30 lines) avoids a new dependency — preferred.
- Do **not** smuggle the token in the URL query string (it lands in logs/history).

Reuse the existing abort/timeout pattern already in the panel
([ScentMissionPanel.tsx:588-630](../../artifacts/scent-cast/src/components/ScentMissionPanel.tsx#L588-L630)):
an `AbortController`, a `MISSION_TIMEOUT_MS` guard, and `controller.abort()` on
unmount / supersede.

---

## 4. Where to splice it in (the panel already has the scaffolding)

[ScentMissionPanel.tsx](../../artifacts/scent-cast/src/components/ScentMissionPanel.tsx)
already holds everything you need — reuse, don't rebuild:

| Existing piece | Reuse for the agent path |
|---|---|
| `authToken` (line ~600) | the `Authorization: Bearer` header on both fetches |
| `busy` / `setBusy` (L463) | true for the whole run; drives the existing thinking animation |
| `progressNote` / `setProgressNote` (L464) | map `status` + `tool_started/completed` events here |
| `sessionId` / `sessionIdRef` (L465) | pass to `POST /runs`, store the returned `sessionId` |
| `appendMessage` / `messages` | push the `completed.response` as the assistant turn |
| `callMission` / `applyResponse` (L596, L635) | the **fallback** scripted path — keep it |
| `weather`, `buildMissionWeather` | build `uiContext.weather` for the run body |

**Suggested flow** for a submitted turn (mirror `runMissionTurn`, the `busy`-guarded
handler near L696):
1. `setBusy(true)`; `POST /runs` with `{ message, sessionId, uiContext:{ weather } }`.
2. Open the SSE reader on `eventsUrl`.
3. On `status` / `tool_*` → `setProgressNote(...)` (humanize tool names — e.g.
   `beam_search_catalog` → "Searching the catalog…").
4. On `completed` → `appendMessage({ role:'assistant', text: response })`, then
   `setBusy(false)`.
5. On `failed` → see §5.

---

## 5. Two design decisions for the implementer

**(a) Free text vs. the structured recommendation card.** The agent returns
`completed.response` as **free text** — it does NOT return the structured
`ScentMissionResponse` (`recommendation`, `nodeUpdates`, `missionPatch`) that
`applyResponse` consumes to populate the `resolved` overlay card. Pick one:
- **MVP (recommended):** render agent text as a chat message; leave the existing
  scripted overlay card path as-is for now. Smallest, safest diff.
- *Later:* add a Phase-2 backend tool/response field that emits a structured pick,
  then feed the overlay. Out of scope for PR2 unless asked.

**(b) Graceful fallback (required).** When the run fails with
`code === "model_unavailable"` (or any agent error), **fall back to the existing
`callMission('/api/scent-mission')` scripted path** so users always get an answer.
This also means PR2 is safe to ship before the prod key is set: no key → silent
fallback to today's behavior. Gate the agent attempt behind a small flag/helper
(e.g. try agent first, catch → scripted) rather than a hard cutover.

---

## 6. Guardrails (workspace rules that apply here)

- **Do not add visible production diagnostics** to the panel (no debug badges /
  on-screen run state). An in-app debug badge was explicitly rejected before on the
  iOS detail-modal work — keep diagnostics in `console`/network only.
- Keep the diff **scoped to the frontend wiring** — no backend contract edits, no
  unrelated community-UI churn (PR1 stayed clean; keep it that way).
- iOS/iPad: the panel runs inside the same WebKit budget constraints as the rest of
  ScentCast — don't add heavy effects to the thinking state; reuse the existing
  animation keyed on `busy`.

---

## 7. Verify (Windows pnpm bootstrap is in the `dev-commands` skill)

```bash
corepack pnpm --filter @workspace/scent-cast run typecheck
corepack pnpm --filter @workspace/scent-cast run build
```
Manual smoke test (needs `OPENROUTER_API_KEY` set locally): log in, open the Scent
Mission concierge, send a message, confirm the network panel shows
`POST /api/beam-agent/runs` → `202`, then the `…/events` SSE stream emits
`status`/`tool_*`/`completed`, and the assistant reply renders. Then unset the key
and confirm the scripted fallback still answers.

---

## 8. Definition of done for PR2

- Concierge sends a turn → agent run starts → progress (`status`/`tool_*`) shows in
  the thinking note → final answer renders as the assistant message.
- Auth works via `fetch`-based SSE (no native `EventSource`).
- `model_unavailable`/error falls back to `/api/scent-mission` with no user-visible
  breakage.
- `scent-cast` typecheck + build green; diff is frontend-only; no visible prod
  diagnostics.

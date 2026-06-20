# Beam Agent — Deep Gap Audit & User Error-Reporting Loop

Date: 2026-06-20
Method: read-only investigation of the canonical Beam path plus two parallel sub-audits.
All findings below are cited to `file:line` in the current working tree and were
spot-verified by the synthesizer. Where a prior doc claim was stale, it is corrected.

Goal of this pass (owner's words): *"understand what would make for the best outcome
for every possible query"* and *"a system so strong that when users do get errors they
can report it so we can update the logic."*

---

## 0. TL;DR — the two structural truths

1. **The live production Beam path (Express `POST /api/beam/runs`) is strong but
   under-instructed and under-grounded at the edges.** The system prompt, tool
   grounding, hallucination guards, and lane separation are solid. The gaps are:
   constraints that are *captured but never enforced* (budget, dislikes), *whole
   query classes with no retrieval primitive* ("smells like X", dupes, similarity),
   and **safety/persona/ontology rules that are written but never loaded into the
   runtime prompt**.

2. **There is no way to learn from a bad answer.** No user feedback affordance
   exists, and — more fundamentally — **no durable, per-turn record is persisted that
   a feedback report could even point at.** The `completed` event the client receives
   does not include the run id, and the answer text / candidates / inputs are never
   stored tied to a stable id. A "report this answer" button added today would have
   nothing actionable to attach to. This must be fixed *before or with* any feedback UI.

---

## 1. Verified corrections to prior audit docs

| Prior claim | Status now | Evidence |
| --- | --- | --- |
| `BEAM_AGENT_LOGIC_AUDIT.md` Follow-up #1: profile search is a sequential scan | **Partly fixed.** A GIN trigram index matching the exact query expression now exists. The 96-row *recall* bound still stands. | `supabase/migrations/20260619120000_global_fragrances_profile_search.sql:26-28` vs query `catalogService.ts:159`; bound `catalogService.ts:48` |
| Root cause #3: new-lane ownership not enforced (`beamAgentLoop.ts:453`) | **Fixed; line moved.** Travel kits with a new lane now force `excludeOwned=true`. | `beamAgentLoop.ts:467-473` |
| `beamObservatory.ts:5` references `docs/beam-agent/beam-beta-observatory.html` | **Stale path.** That HTML file is not present; only `.md` docs exist. | filesystem check |
| `conversations.ts` / `messages.ts` schema are part of the runtime surface | **Inert.** Present on disk, not exported, not in runtime schema. | `lib/db/src/schema/index.ts:1-20` |

---

## 2. Answer-quality gaps (ranked by impact on "remarkable for every query")

Severity = how often it produces a visibly sub-par answer × how silent the failure is.

### A1 — Runtime `SYSTEM_PROMPT` never loads the `hermes-beam` safety/persona/ontology rules (HIGH)
- **Symptom:** Out-of-domain questions, allergen/ingredient-safety asks, dupe/clone
  framing, and honest catalog-miss recovery are handled inconsistently on the live path.
- **Evidence:** The Express loop builds the prompt as `SYSTEM_PROMPT +
  beamSessionStatePrompt(...)` only (`beamAgentLoop.ts:661`). A repo-wide search confirms
  **nothing** in `artifacts/api-server/src/` references `hermes-beam`, `beam-context`,
  `SOUL.md`, `SAFETY.md`, `FRAGRANCE_ONTOLOGY.md`, or `TOOL_RULES.md` — verified empty.
  Those rules (out-of-domain decline `SAFETY.md:25-27`, no allergen claims `SAFETY.md:27` /
  `FRAGRANCE_ONTOLOGY.md:32`, dupe framing `FRAGRANCE_ONTOLOGY.md:33`) only reach the
  separate Hermes/MCP runtime, not production Express.
- **Why it matters:** Two instruction surfaces that are silently allowed to drift; the
  carefully-authored safety/persona guidance does not protect the path real users hit.
- **Fix direction:** Port the relevant SAFETY/ONTOLOGY/SOUL guidance into the runtime
  `SYSTEM_PROMPT`, or load the `beam-context/*.md` files at boot so they cannot diverge.

### A2 — Budget is captured and shown to the model but never filters retrieval (HIGH)
- **Symptom:** "Under $80" / the "Budget-friendly" chip → Beam still recommends a $300 niche bottle.
- **Evidence:** `parseBudget` captures only `under/below/max/budget/less than $NNN`
  (`missionState.ts:467-470`), stored (`:681`), surfaced only as a "Known so far" line
  (`:807`). No tool consumes it — `beam_search_catalog` (`beamTools.ts:261-286`) and
  `beam_score_candidates` (`beamTools.ts:425-510`) expose **no price/budget parameter**;
  `slots.budget` is read nowhere outside `missionState.ts`.
- **Fix direction:** Add a `maxPriceUsd` arg to search/propose tools (requires price in
  `global_fragrances`), or at minimum a hard prompt constraint + a quality gate that
  rejects a headline pick above the stated budget. Broaden `parseBudget` (misses
  `$50-100`, "cheap", "affordable", "splurge").

### A3 — Dislikes / anti-notes are suppressed, not excluded (HIGH)
- **Symptom:** "No oud, I hate anything sweet" → gourmand/oud picks can still surface.
- **Evidence:** Negation handling (`missionState.ts:286-301`, `parseDirection :341-355`)
  only stops a negated family from entering the **positive** `direction` slot. There is no
  `avoid`/anti-note slot and no exclusion term reaches retrieval — `searchCatalogProfileCandidates`
  builds only positive `terms` (`catalogProfileSearch.ts:119-125`).
- **Fix direction:** Capture negated families into an `avoid` slot; pass exclusion terms to
  profile search to drop/down-rank matching candidates; gate an answer that headlines an avoided note.

### A4 — No similarity / "smells like X" / dupe-clone retrieval primitive (HIGH)
- **Symptom:** "Smells like Baccarat Rouge but cheaper", "a Sauvage clone", "something like
  Aventus" — the single most common high-intent fragrance query class — has no backing retrieval.
- **Evidence:** No gender/similarity concepts in slot keys (`types.ts:61-71`),
  `FAMILY_PATTERNS` (`missionState.ts:316-339`), or `VIBES` (`:97-111`). `scent_vector` only
  **reranks** keyword hits (`catalogProfileSearch.ts:151-157`); it is never a retrieval index.
  `searchCatalogProfileCandidates` is identity-then-keyword only (`catalogService.ts:136-182`).
- **Fix direction:** Add a similarity tool: resolve the reference fragrance, then
  nearest-neighbor over `scent_vector` + shared accords. This unlocks an entire query class.

### A5 — Gates judge safety/flow, never taste or correctness (HIGH — structural ceiling)
- **Symptom:** A confidently-worded but mediocre, off-target, or subtly wrong pick passes
  every gate and ships as if "remarkable".
- **Evidence:** `runAnswerQualityGates` only checks price/availability/review claims,
  instruction leaks, length, and slot/mission-flow (`answerQualityGates.ts:240-303`, patterns
  `:37-50`). No relevance/accuracy/quality scoring exists. The module header says so itself (`:1-8`).
- **Why it matters:** "Remarkable for every query" is a *taste* bar; this module is a
  guardrail, not a judge. **This is the strongest argument for the feedback loop in §3** —
  taste/correctness can only be measured from real user verdicts, not regex.

### A6 — Soft-flow violations are deliberately overridden — flawed-flow answers ship (MEDIUM-HIGH)
- **Symptom:** An answer that re-asks an already-answered question, abandons the pending
  clarification, or asks a preference after the user delegated, still ships if it names a grounded pick.
- **Evidence:** `SOFT_FLOW_VIOLATIONS = {pending_slot_abandoned, redundant_clarification,
  delegated_but_questioned}` (`beamAgentLoop.ts:79-83`); when only soft gates fail and there is
  a grounded answer, `qualityGatePassed` is forced `true` (`:935-944`). This is an intentional
  tradeoff (avoid dead-ending a 40-name run), but the "didn't listen" defects users most notice
  are allowed through. Observability nuance: `qualityViolations` retains the overridden codes but
  `qualityGatePassed` flips to true — so dashboards under-count flow defects.
- **Fix direction:** Keep the ship-anyway behavior, but emit a distinct telemetry signal
  (`shippedWithSoftViolations`) so these are visible — and make them prime candidates for the feedback loop.

### A7 — Lane selection can route a hard query to the cheap orchestration model (MEDIUM)
- **Symptom:** A constraint-dense one-shot ("smells like rain on hot pavement, sophisticated
  not stuffy, under $100") routes to the cheap `default` lane for orchestration.
- **Evidence:** `selectConciergeLane` escalates only on active travel kit, ≥8 turns, ≥600 chars,
  or trip-ish `PREMIUM_PATTERNS` (`laneSelector.ts:45-57, 73-89`). A short, hard, non-trip
  recommendation matches none. The closing synthesis turn does use the strong model
  (`provider.ts:79`, `beamAgentLoop.ts:813`), but orchestration decides *what to retrieve* — a
  weak orchestrator formulates a poor search and the strong closer can only synthesize the weak set.
- **Fix direction:** Add a complexity heuristic (multiple constraints, negations, "smells like",
  named-reference comparison) to escalate constraint-dense single messages.

### A8 — Captured occasion is lossily projected onto the scorer's 6+5 enums (MEDIUM)
- **Symptom:** "First date at a jazz bar" / "job interview" / "funeral" → squashed; the one
  deterministic ranking signal scores a coarser occasion than the user gave.
- **Evidence:** `beam_score_candidates` accepts only 6 destinations + 5 energies
  (`beamTools.ts:184-192`); the richer 14-value `occasion` slot (`missionState.ts:80-95`) is not
  mapped to them, so it reaches the scorer only as prose.
- **Fix direction:** Map the 14 occasion labels into the scorer's enum space (or extend the enums).

### A9 — Weather/humidity & longevity-vs-sillage have no structured slots (MEDIUM)
- **Symptom:** "Brutally humid here" and "lasts all day but stays close to skin" (high longevity +
  low sillage) survive only as raw text; the model must invent `weatherOverride` numbers from memory.
- **Evidence:** No weather slot; `parseSeason` deliberately ignores bare "hot/humid" (`missionState.ts:38-45,185-191`).
  Only `projection` is captured, no longevity slot (`:357-362`); the synthesis prompt also bans
  reporting either as a number (`beamAgentLoop.ts:242-243`). No native performance retrieval dimension.
- **Fix direction:** Add structured climate/daypart + a longevity slot distinct from projection;
  add performance retrieval fields (prior Follow-up #2/#3).

### A10 — Profile retrieval is keyword-overlap over JSON text, recall-bounded at 96 (MEDIUM)
- **Symptom:** Niche/paraphrased queries ("smoky leathery animalic with a powdery drydown") get
  shallow candidate pools; synonymy ("animalic" ≈ "civet/skanky") is missed.
- **Evidence:** `MAX_PROFILE_CANDIDATES = 96` (`catalogService.ts:48`), ordered by term-match
  count then `lookup_key` (`:127`), matched via substring `LIKE` over profile JSON (`:159-163`).
  The GIN index fixes scan speed, not recall or semantics.
- **Fix direction:** Generated search document / `tsvector` or dedicated profile columns; a true
  vector-similarity dimension (ties to A4); raise/remove the 96 bound once indexed.

### A11 — Research/freshness lane ships OFF by default (MEDIUM)
- **Symptom:** "Is X discontinued / how much / what do reviews say" → with the lane off, the agent
  must omit or hedge the claim.
- **Evidence:** `isResearchEnabled` requires `OPENROUTER_API_KEY` + `BEAM_RESEARCH_ENABLED`
  (`research/researchConfig.ts:85-89`); when off, `beamResearch.ts:129-133` returns an empty note and
  `hadExternalEvidence` stays false, so price/availability/review phrasing is stripped
  (`answerQualityGates.ts:245-249`). Cached facts can also be up to their TTL old (price 12h,
  availability 48h — `researchPolicy.ts:216-233`) without surfacing `retrievedAt` to the user.
- **Fix direction:** Decide whether freshness is a shipped capability; if so, enable + surface
  retrieval timestamps. If not, make the "I can't verify live" copy graceful.

### A12 — Scripted degraded fallback collapses intent to two enums (LOW — outage-only)
- **Symptom:** When no model is configured, `/api/scent-mission` replies robotically and defaults
  to `Going Out`/`Confident`.
- **Evidence:** `deterministicChatReply` → `inferCalibrationFromMessage` maps free text only to
  destination/energy patterns (`scentMissionService.ts:289-376`); everything else is dropped. This is
  the non-Beam degraded path; impact is limited to provider outages/misconfig.
- **Fix direction:** Preserve open-ended free text in the fallback (prior Follow-up #4).

### Confirmations that held up (no gap)
- New-lane ownership enforcement (`beamAgentLoop.ts:467-473`), identity-first short-circuit
  (`catalogService.ts:144-145`), hallucination allowlist pinning (`beamAgentLoop.ts:301-310,1195`),
  and premium-orchestration ≠ cheap-synthesis separation (`provider.ts:68-89,188-212`) are all sound.

---

## 3. The missing feedback / error-reporting loop (the owner's core ask)

### 3.1 Definitive finding: nothing exists, and nothing is even *pointable-at*

- **No UI affordance.** `ScentMissionPanel.tsx` (~2,836 lines) and `App.tsx` have zero
  thumbs/report/rating surface for a Beam answer; every "report" hit is image/curation telemetry
  (e.g. `BottleImage.tsx:163`). `beamAgentClient.ts` exposes only run/stop/events.
- **No backend route.** `beamAgentRoutes.ts` exposes `POST /runs`, `GET /runs/:id/events`,
  `POST /runs/:id/stop`, and a token-gated ops-only `GET /observatory/feed` (`:302-602`). No `/feedback`.
- **No table.** `lib/db/src/schema/index.ts:1-20` exports 20 tables; none is feedback (community
  reactions/votes are for community posts, not Beam answers).
- **No durable per-turn record to attach a report to.** This is the deeper blocker:

| Datum | Reaches client? | Persisted durably & joinable? |
| --- | --- | --- |
| `runId` (`run_<uuid>`, minted `beamAgentRoutes.ts:341`) | Only in the `POST /runs` 202 body (`:481`); the **`completed` SSE event is `{type,response}` with no id** (`types.ts:294`, `beamAgentLoop.ts:972`) | No — in-memory run registry, 30-min TTL |
| `sessionId` (`beam_<uuid>`) | Yes | No — Redis/in-memory, 60-min TTL (`beamSessionStore.ts:17`); identifies conversation, not the turn |
| Final answer text | Yes (in `response`) | **No — never stored tied to an id** |
| Inputs (message, slots, mission) | Derived (`beamAgentRoutes.ts:375`) | No — session store only, 60-min TTL |
| Lane / models / tokens / cost / gate result | Logged + ring buffer | `api_usage_ledger` row is durable but has **no runId/sessionId/message columns** (`apiUsageLedger.ts:14-52`); observatory is in-memory, redacted, 200-entry (`beamObservatory.ts:91-92,159-182`) |
| Grounded candidates | Only a **count** (`beamAgentLoop.ts:1268`) | No — names/ids not retained |

**Conclusion:** adding a feedback button first requires persisting a per-turn record and
returning its id to the client. Otherwise a report points at nothing.

### 3.2 Minimal system design (fits existing house patterns)

The Drizzle pattern in `researchCache.ts` / `apiUsageLedger.ts` (uuid PK `defaultRandom()`,
`tenant_id`/`user_id` uuid refs, `jsonb` blobs, tz timestamps, indexed FKs; additive table, same
`drizzle push` tablesFilter caveat) supports two new tables cleanly. `scentRushRuns` is precedent
for a per-run log table.

**Step 1 — persist a durable turn record (prerequisite, no UI yet).**
New table `beam_answer_log` written at run completion in `beamAgentRoutes.ts` (alongside the existing
ledger write at `:463-473`), keyed by the already-minted `runId`:
- `id` (= runId), `tenant_id`, `user_id` (hashed or FK), `session_id`, `created_at`
- `user_message`, `derived_state` jsonb (slots+mission already computed at `:375`)
- `lane`, `orchestration_model`, `synthesis_model` (already in the summary `:438-441`)
- `grounded_candidates` jsonb (**upgrade `groundedNames` from a count to names/ids** —
  `beamAgentLoop.ts:1268`)
- `final_answer` text, `gate_passed`, `gate_violations` jsonb, `shipped_with_soft_violations` (A6)
Retention can be short (e.g. 30 days) — it exists to diagnose reports, not as a transcript store.

**Step 2 — return the id to the client.** Add `runId` (and the log id) to the `completed` event
payload (`types.ts:294`, emitted `beamAgentLoop.ts:972`) so the SPA can tag each rendered answer bubble.

**Step 3 — feedback table + route.**
New table `beam_answer_feedback`: `id`, `answer_log_id` (FK → `beam_answer_log.id`), `user_id`,
`verdict` (`up`/`down`), `reason_code` (enum: wrong pick / ignored constraint / off-tone /
hallucinated / too generic / other), `note` text, `created_at`.
New route `POST /api/beam/feedback` (mirrors `beamAgentRoutes` auth) that inserts a row.

**Step 4 — UI affordance.** A small thumbs-up/down on each delivered Beam answer bubble in
`ScentMissionPanel.tsx`; thumbs-down opens a one-tap reason-code chip set (reuse the existing
`cues` chip rendering). Calls `POST /api/beam/feedback` with the tagged answer id.

**Step 5 — close the loop into logic.** Because a `down` row now joins to the full input/candidate/
output record, each report becomes a reproducible fixture. The pipeline:
`down + reason_code` → triage → add a regression test to `beamFlowRegression.test.ts` /
`beamAgentLoop.test.ts` (the existing deterministic harness already replays real inputs) → fix the
owning layer (extraction, retrieval, prompt, or gate) → the test locks it. This matches the doctrine
already in `BEAM_AGENT_LOGIC_AUDIT.md:51` ("tests must grow from real failures") — the feedback loop
is what *supplies* those real failures.

### 3.3 Why this directly serves "best outcome for every query"
A5 establishes that no automated gate can judge taste/correctness. The only scalable signal for
"was this actually remarkable?" is the user verdict. Steps 1-2 make answers *diagnosable*; steps 3-5
turn each complaint into a regression-locked logic update. That is the system the owner asked for.

---

## 4. Recommended order of work

1. **Feedback prerequisite (Steps 1-2 of §3.2):** persist `beam_answer_log` + return the id in the
   `completed` event, and upgrade `groundedNames` to retain candidate ids. *Nothing is debuggable
   or reportable until this lands.*
2. **A1:** unify the runtime prompt with the `hermes-beam` safety/ontology rules (largest silent blind spot).
3. **A2 + A3:** make budget and dislikes actually filter retrieval (captured-but-inert today).
4. **Feedback Steps 3-5:** table, route, UI, and the report → regression-test loop.
5. **A4:** similarity / "smells like X" retrieval tool (unlocks a whole query class).
6. **A6 / A7 / A8:** soft-violation telemetry signal; escalate constraint-dense queries; map occasions to scorer enums.
7. **A9 / A10 / A11:** structured climate + longevity slots, indexed/semantic retrieval, freshness-lane decision.

---

## 5. Verification of this audit

- Two parallel read-only sub-audits (understanding+retrieval; gates+research+MCP+observability+feedback),
  each citing `file:line`, cross-checked by the synthesizer.
- Synthesizer spot-verified the load-path claim (A1: Express never references `hermes-beam` — search
  empty), the `completed` event shape (`types.ts:294`), the soft-gate override (`beamAgentLoop.ts:935-944`),
  the slot surface (`types.ts:61-122`), and the absence of any feedback table/route/UI.
- No code was changed in this pass. No tests were run for this document (read-only audit); the prior
  216-test focused gate and 537-test API suite results in `BEAM_AGENT_LOGIC_AUDIT.md` were not re-run here.
- Open risk: the design in §3.2 is a proposal, not yet implemented; the `drizzle push` shared-DB caveat
  (`researchCache.ts:25-27`) applies to the two new tables.

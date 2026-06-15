# 07 — Beam Agent experience: improvement audit

**Purpose.** A high-altitude but code-grounded map of the *whole* "Beam Agent"
surface (what the user feels + what powers it), with a prioritized list of small,
surgical iterations that move it toward a seamless, premium experience. Every item
names the exact file/line and the size + risk of the fix so an agent can act
**delicately and precisely** without re-discovering the system.

> **Status — implemented in `feat/beam-agent-experience-polish`.** The P0/P1/P2
> items below were addressed under the **"enrich path A"** direction, *except* the
> §3.3 / §6 "mount backend **B**" lift, which remains a separate, larger effort.
> Highlights now live: Premium renders real note-architecture research (no more
> paywall teaser), all nine facets feed the reply, the model's text is trusted,
> intent inference is unified in `lib/scent-weather-engine/scentInference.ts`, and
> the P2 polish + brand pass landed. The original audit text is kept verbatim
> below as the rationale for each change.

Cross-check the [no-touch list](#what-not-to-touch) before further editing.

---

## 1. What "the Beam Agent experience" actually is

There are **three different systems wearing one brand name**, plus one React panel
the user sees. Understanding this split is the key to fixing anything safely.

| Layer | Path | Status | Model stack |
|---|---|---|---|
| **A. Live backend** (what ships today) | `routes/scentMission.ts` + `services/scentMissionService.ts` + `lib/scent-weather-engine` | **Live, mounted** | OpenAI `gpt-4.1-mini` → Gemini `gemini-2.5-flash` for chat; deterministic engine for the actual pick |
| **B. In-process Claude loop** | `api-server/src/beam-agent/*` | Built **and mounted** (`app.ts` calls `mountBeamAgent`); `ScentMissionPanel` routes turns here via `beamAgentClient.ts`, falling back to **A** | Anthropic Claude (`claude-haiku-4-5`) via `claudeProvider.ts` |
| **C. MCP / Hermes runtime** | `api-server/src/beam-agent/mcp/*` + `hermes-beam/` | Additive runtime path | OpenRouter brain (`gpt-5.4-mini`) + Sonnet / Mistral / deep-research specialists |
| **D. The UI** | `components/ScentMissionPanel.tsx`, wired in `App.tsx`, loader in `ScentIntelligenceLoader.tsx` | **Live** | Talks only to **A** (`/api/scent-mission`) |

The user-facing panel (**D**) is branded **"Beam Agent"** everywhere. It now
routes conversational turns to backend **B** (the real tool-loop) and falls back
to backend **A** — the old scripted node-wizard — when the model is unavailable.
System **C** (MCP/Hermes) is the additive runtime path. The full file inventory:

```
artifacts/scent-cast/src/
  components/ScentMissionPanel.tsx        # the panel the user chats with (→ /api/scent-mission)
  components/ScentIntelligenceLoader.tsx  # orbital "intelligence" loader (search/add flow)
  lib/scentMissionClient.ts               # buildMissionWeather/Wardrobe, one-shot fetch helpers
  App.tsx (≈540–830)                      # header strip, view swap, cue-host portal, CTA

artifacts/api-server/src/
  routes/scentMission.ts                  # POST /api/scent-mission (live), picks OpenAI/Gemini
  services/scentMissionService.ts         # stateless node executor + deterministic chat fallback
  beam-agent/                             # (B) Claude tool-loop — mounted via mountBeamAgent(app)
    beamAgentLoop.ts beamTools.ts beamToolCore.ts claudeProvider.ts beamAgentRoutes.ts
    mcp/                                   # (C) MCP server + specialist model tools
      beamMcpServer.ts mcpMain.ts beamModelConfig.ts openRouterProvider.ts specialistTools.ts …
lib/scent-weather-engine/src/scentMission.ts   # pure node graph + selectScentMissionRecommendation

hermes-beam/                              # (C) Hermes agent profile: AGENTS.md, SOUL.md, beam-context/, skills/
docs/beam-agent/00…06                     # architecture, current-state, contract, migration, model lineup
```

---

## 2. The central tension (read this first)

The migration plan ([03](./03-migration-plan.md)) is explicit: build a *new*
`BeamAgentPanel` **alongside** the old one, and **do not** rename or rewrite
`ScentMissionPanel.tsx` in place. The live UI has instead **rebranded the old
scripted panel to "Beam Agent"** while keeping the fake node flow underneath.

So today's premium-feel problems nearly all trace to one root: **the product
promises an agent and ships a form.** The fixes below are grouped by whether they
(P0) close that promise gap, (P1) smooth the conversation, or (P2) polish details.

---

## 3. P0 — Promise-gap fixes (what makes it feel "not premium")

### 3.1 Fake "Premium" mode is a paywall that does nothing
- **Where:** `ScentMissionPanel.tsx` MODE_OPTIONS Premium + `Lock` icon (74–78), `handlePremiumPreview` (785), the "Preview" button (1035); backend `scentMissionService.ts:executeNode` `resolution-premium` returns `PREMIUM_LOCK` (196–201, 431–436).
- **Why it hurts:** a lock-shaped, paywall-shaped control that resolves to *"Premium access is coming soon"* / *"Premium mode is staged…"* reads as unfinished, not exclusive. A premium product never shows an empty vault door.
- **Delicate fix (S):** hide the Premium mode chip + Preview button behind a build flag until it does real work, **or** make "Premium" deliver something tangible now (e.g. the deeper note-architecture copy you already research but discard — see 5.3). Don't ship the teaser.

### 3.2 Nine facets collected, two consumed
- **Where:** `ScentMissionPanel.tsx` `QUICK_REPLIES` covers 9 facet groups incl. **budget** (98–128); backend only reads `destination` + `energy` (`scentMissionService.ts` calibration, [01-current-state §"UI promises more"](./01-current-state.md)).
- **Why it hurts:** budget chips ("Under $150", "No budget cap") imply shopping that never happens; personality/impression/creativeDirection are collected then dropped. The user does work that has no effect — the opposite of seamless.
- **Delicate fix (M):** either (a) trim the cue set to what the engine actually uses, or (b) thread the extra facets into the chat prompt context so they visibly shape the reply. Pick one; don't keep collecting-and-discarding.

### 3.3 The "agent" can't discover — it only re-ranks the vault
- **Where:** `selectScentMissionRecommendation` scores **owned bottles only**; empty/!1 vault dead-ends with *"Add fragrances from search first"* (`ScentMissionPanel.tsx:182–187`, `initialAgentMessage`).
- **Why it hurts:** the identity (`hermes-beam/AGENTS.md`, `SOUL.md`) promises "discover **real** fragrances," but the live path can't. New users with thin vaults hit a wall instead of a recommendation.
- **Delicate fix (L, gated):** this is exactly what backend **B/C** unlock (`beam_search_catalog`). The premium move is to mount the real loop behind a flag (per [03 Phase 2](./03-migration-plan.md)) rather than bolt discovery onto the scripted route. Short-term (S): soften the empty state into a guided "let's add one" rather than a dead message.

### 3.4 Brand-name drift across the surface
- **Where:** UI says **"Beam Agent"** (ScentMissionPanel, App.tsx header); route/service/domain say **"Scent Mission"**; backend prompts say *"You are the Scent Mission agent"* (`scentMission.ts:61`); avatar `alt="ScentCast Beam Agent"` (`ScentMissionPanel.tsx:837`) while the product is **ScentBeam**.
- **Why it hurts:** inconsistent naming is the cheapest tell that a product is stitched from phases. "ScentCast" vs "ScentBeam" in user-visible alt text is a straight bug.
- **Delicate fix (S):** pick one user-facing name ("Beam"), fix the avatar `alt`, and align the backend system-prompt persona. Internal file names can stay — this is a copy pass, not a rename.

---

## 4. P1 — Conversation seamlessness

### 4.1 The reply you read is mostly *not* the model's
- **Where:** `handleSubmit` appends `safeAssistantText(response?.assistantMessage, scriptedFallback)` (759); `safeAssistantText` (257–264) **discards** any model reply mentioning "mission tree / execute analysis / resolution node" — which is exactly what the deterministic backend emits (`scentMissionService.ts:250,265`). Net effect: scripted frontend copy wins most turns.
- **Why it hurts:** the chat *feels* canned because it largely is. This is the #1 driver of "not a real concierge."
- **Delicate fix (M):** decide the source of truth. If the LLM reply is trusted, stop overriding it; if not, stop paying for it (4.4). The half-and-half is the worst of both.

### 4.2 Duplicated, drifting intent inference (client + server)
- **Where:** `ScentMissionPanel.tsx:inferTextFacets` (281–345) **and** `scentMissionService.ts:inferCalibrationFromMessage` (287–309) both regex the same user message with **different** pattern sets (e.g. client maps "dinner"→Date; server only "dinner date"→Date).
- **Why it hurts:** the two can disagree on the same sentence, so calibration the user sees ≠ what the server scored on.
- **Delicate fix (M):** lift one shared inference helper into `lib/scent-weather-engine` and call it from both sides. Single source of truth.

### 4.3 Regex collisions misread the user
- **Where:** `inferTextFacets` — "subtle" sets **both** `mood: Calm` (311) **and** `projection: Skin-close` (331); "fresh" → `impression: Clean` (337). No negation handling ("not too strong" still triggers `Statement`).
- **Why it hurts:** a confident-but-wrong calibration is worse than none; the user feels misheard.
- **Delicate fix (S–M):** de-dupe the overlapping tokens, and gate projection/impression on stronger phrases. Low risk, immediate "it gets me" payoff.

### 4.4 Research is computed, then thrown away
- **Where:** `scentMissionService.ts` resolution-standard fetches `deps.research(...)` and returns it (408–428); the panel's `applyResponse` (586–624) handles `recommendation`/`premiumLock`/`assistantMessage` but **never renders `response.research`**.
- **Why it hurts:** a real `getScentFacts` LLM call runs on every resolution and is discarded — latency + spend for zero user value.
- **Delicate fix (S):** either render the research (it's perfect "premium depth" for 3.1) or stop fetching it. Don't pay for invisible work.

### 4.5 Latency theater stacks up
- **Where:** `introReady` 920 ms (482) + `cuesReady` +320 ms (489) before the greeting/cues are interactive; `MIN_THINKING_MS` 700 ms artificial hold per chat turn (153, 751).
- **Why it hurts:** deliberate pacing reads as premium *up to a point*; stacked, a fast network still waits ~1.2 s to start and 0.7 s+ per turn. On the resolution path there's no streaming, so a 20 s LLM timeout can feel frozen.
- **Delicate fix (S):** tune the intro to a single settle (~500–600 ms total) and make `MIN_THINKING_MS` a floor only when the response was genuinely instant. Consider SSE streaming when backend **B** lands (it already emits `status`/`tool_*` events).

---

## 5. P2 — Polish punch list (the "little things")

Each is small, low-risk, and individually cheap — collectively they're most of the
"premium feel" delta.

| # | Issue | Where | Fix |
|---|---|---|---|
| 5.1 | Copy reads as a typo: **"Checking today air"** | `ScentMissionPanel.tsx:141` `PROGRESS_COPY['environment-scan']` | → "Checking today's air" |
| 5.2 | Temp shows **`72F`** (no degree sign), hardcoded °F, no locale | `ScentMissionPanel.tsx:514` vs backend uses `°F` (`scentMissionService.ts:211`) | Add `°`; centralize formatting; respect unit pref |
| 5.3 | A normal nudge looks like an **error** (red system bubble) | `ScentMissionPanel.tsx:673` "needs one more cue" uses the same red style as real errors (1182) | Add a neutral "hint" message role distinct from `system` errors |
| 5.4 | `onBlur` force-scrolls the page to top on **every** blur (iOS hack applied globally) | `ScentMissionPanel.tsx:868–871` | Gate on iOS / `visualViewport` so desktop blur doesn't yank the page |
| 5.5 | Dead-end reveal: *"This pick is no longer in your local vault…"* offers no recovery | `ScentMissionPanel.tsx:1247–1249` | Offer "search for it" / "re-run" instead of a terminal sentence |
| 5.6 | Avatar `alt="ScentCast Beam Agent"` — wrong brand | `ScentMissionPanel.tsx:837` | → "ScentBeam Beam Agent" (see 3.4) |
| 5.7 | sr-only facet summary announces facets (budget, etc.) the backend ignores | `ScentMissionPanel.tsx:1256–1258`, `formatFacetLine` | Trim to consumed facets once 3.2 is resolved |

---

## 6. Backend coherence (for when B/C go live)

- **Three model stacks, three keys.** Live chat = OpenAI/Gemini (hardcoded
  `gpt-4.1-mini`/`gemini-2.5-flash`, not env-configurable — `scentMission.ts:87,101`);
  loop **B** = Anthropic; runtime **C** = OpenRouter. Before the user ever meets
  the "real" Beam, decide **one** runtime so cost, latency, and voice are uniform.
- **Speculative model slugs.** [06-model-lineup](./06-model-lineup.md) pins
  `gpt-5.4-mini`, `claude-sonnet-4.6`, `mistral-large-2512`, `o4-mini-deep-research`.
  The doc itself says "confirm exact slugs" — validate against OpenRouter before
  enabling, or specialist tools 404 at runtime.
- **The identity is already excellent.** `hermes-beam/SOUL.md` + `AGENTS.md` define
  exactly the grounded, non-sycophantic, "name the notes" voice a premium product
  wants. The gap is purely that the **live** path (A) doesn't run that brain. When
  B/C mount, the voice work is done.

---

## 7. Suggested sequencing (cheapest premium-feel per hour)

1. **§5 punch list** + **§3.4 brand pass** — an afternoon, pure copy/CSS, zero
   architectural risk, immediately reads cleaner.
2. **§3.1 hide fake Premium** + **§3.2 trim/wire facets** + **§4.4 research** —
   stop showing/charging for things that do nothing.
3. **§4.1–4.3 inference unification** — make the chat feel heard.
4. **§3.3 / §6** — the real lift: flip on backend **B** behind a flag per
   [Phase 2](./03-migration-plan.md). That's the step that turns the form into an
   agent; everything above makes that landing feel premium when it arrives.

---

## What not to touch

From [03-migration-plan §No-touch](./03-migration-plan.md) — still binding:

- Don't rename broad dirs or move files; keep changes additive.
- Don't change `lib/scent-weather-engine` scoring — it's the single source of truth
  for the deterministic pick (the one honest thing in path A).
- Don't duplicate the weather-scoring logic or add a second collection schema.
- Don't expose a personal Claude/OpenRouter credential to browser code.
- Treat the `source_coverage` / `derived_metrics` cross-service contract as frozen
  (see `repo-map` / `cross-service-contract`) — the Beam work doesn't need to touch it.
```

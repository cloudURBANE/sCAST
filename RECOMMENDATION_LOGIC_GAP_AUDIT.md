# Recommendation Logic — Web-App-Wide Gap Audit & Redesign

Date: 2026-06-26
Branch: `claude/recommendation-logic-gaps-lr6jn4` (both `sCAST` and `srt-scent-engine`)

Produced by a 6-way parallel audit of the recommendation pipeline:

1. Core scoring engine — `lib/scent-weather-engine/src/scentWeatherEngine.ts`
2. Backend vectorization — `scentEngine.ts` / `scentVectorizer.ts` / `scentParser.ts`
3. Weather & context inputs — `weatherService.ts`, engine input interface
4. Data completeness / coverage — Python engine `derived_metrics`/`source_coverage`, `fragranceApi.ts`
5. Personalization & learning — taste profile, feedback loop, DB schema
6. Multi-day planning & surfacing — `weeklyOutlookPlanner.ts`, scent mission, App.tsx UX

---

## Root pathology: signals are computed, then discarded

The pipeline is far richer at its edges than what reaches the scoring math. Intelligence
is wired to the engine's doorstep and dropped.

| Signal | Status | Source |
|---|---|---|
| `userPreference` (skin longevity / projection pref) | Engine input exists & used in spray math — never passed by app | A1, A5 |
| `season` | Engine field exists — never populated | A1, A3, A4 |
| Wind | Engine has `wind_rule` + spray/confidence branch — never fetched from provider (always 0) | A3 |
| UV index | Fetched, plumbed to engine boundary — dropped | A3 |
| `outdoor` / `close_contact` settings | Engine logic exists — no UI produces them | A3 |
| Parsed `accords` | Computed by parser — vectorizer never reads them | A2 |
| Engine `derived_metrics` + projection | Authoritative metrics — discarded, re-derived from weak vector | A2, A4 |
| Crowd season/day-night/gender/interest/sentiment/value votes | Produced by Python engine — only planner uses any; core engine uses none | A4 |
| Per-candidate data-confidence (`present/4`) | Computed — planner only, not the primary pick | A1, A4 |
| `beam_answer_feedback` (incl. `ignored_dislike`) | Captured on every thumbs-down — write-only, never read back | A5 |
| Ranked runner-ups | Fully ranked list computed — discarded except the LLM feed | A6 |

## Four structural defects

1. **Confidence is field-presence, not data-quality** (A1/A2/A4). A single noisy token earns
   "high" confidence + a 92-base display score, identical to a fully-enriched profile.
2. **GIGO at the vector** (A2). ~130-word substring dictionary (lavender/coconut/almond/tea map
   to nothing), cross-note substring bleed, no normalization, and empty profiles persisted with
   plausible `{longevity:4, sillage:3}` metrics and no provenance flag.
3. **Three divergent scoring formulas** (A6). Mission chat, home hero, and forecast strip rank the
   same wardrobe with different math; home hero vs forecast day-0 are separate paths that can disagree.
4. **No personalization / learning — 2/10** (A5). Identical wardrobes → identical answers. No taste
   profile, dislike memory, repetition avoidance, or cold-start; feedback loop is write-only.

Plus: home pick never re-scores on weather change (A1); `api.py:1667` `complete` contract bug marks
partial details "complete" and halts self-heal (A4).

---

## Full findings (file:line · severity · minimal fix)

### A1 — Core scoring engine
- **GAP1 (High):** Home rec never re-scores on weather change. `WardrobeContext.tsx:2257-2267`. Fix: effect that re-runs `calculateEngineAlignment` on `weather` change using a stored last-intent.
- **GAP2 (Med):** `userPreference` used by engine (`scentWeatherEngine.ts:650,656,716`) but never built in `buildEngineInput` (`WardrobeContext.tsx:716-737`). Fix: thread `user_settings` → input.
- **GAP3 (Low):** `weather.season` read at `scentWeatherEngine.ts:833-836` but never set. Fix: derive in builder.
- **GAP4 (High):** `calculateConfidence` (`scentWeatherEngine.ts:773-794`) awards "high" on any one family/accord. Fix: require richer threshold / accept caller `dataQuality`.
- **GAP5 (Med):** Empty-trait fragrance still yields confident generic rec (`:551-553`, `:787`). Fix: force `low` confidence + flag weather-only.
- **GAP6 (Med):** Magic-number cliffs (85°F/75% humidity flip whole verdict) `:312-377`, `:400`, `:481-552`. Fix: named constants + interpolation.
- **GAP7 (Med):** `getBaseSprayCount` treats unknown concentration == EDP (`:288-296`); band can collapse. Fix: distinguish unknown + lower confidence.
- **GAP8 (Med):** Single-pick tie-break biases to wardrobe insertion order (`WardrobeContext.tsx:844`). Fix: deterministic non-order tie-break.
- **GAP9 (Low):** `intent.energy` only a flat +3 tag bonus, never reaches engine. Fix: document + constants.
- **GAP10 (Low):** `musk`/`clean` double-mapped across fresh + musky families (`:154-192`). Fix: consistent assignment.

### A2 — Backend vectorization
- **GAP1 (High):** ~130-keyword substring dictionary; unmatched notes contribute 0 silently. `scentVectorizer.ts:29-117`. Fix: expand RULES + add match-ratio coverage metric.
- **GAP2 (Med):** Unbounded order-blind substring matching → false positives + frequency-insensitive. `:109-117`. Fix: tokenize to note set, whole-token match.
- **GAP3 (High):** Sparse/empty → all-zero vector + plausible `{sillage:3,longevity:4}` persisted with no provenance. `scentEngineCore.ts:425-463`. Fix: add `vector_confidence` field; gate metrics on usable notes.
- **GAP4 (Med-High):** Parsed `accords` never feed the vector. `scentParser.ts:34-60` vs `scentVectorizer.ts:124-154`. Fix: low-weight accord→axis pass.
- **GAP5 (High):** Engine `derived_metrics`/projection discarded; re-derived from weak vector. `engineResolve.ts:110-147`. Fix: carry + prefer engine metrics when coverage complete.
- **GAP6 (Med):** No cross-axis normalization; arbitrary +2.5 floor. `:147-153`. Fix: per-axis normalize.
- **GAP7 (Low-Med):** Concentration → metrics only, not vector; pyramid presence hard-discards flat notes. `:135-142`. Fix: blend flat notes for empty layers.
- **GAP8 (Med):** Inferred pyramid mis-tiers via thin lists → biased position weights. `fragranceNotes.ts:114-132`. Fix: flat-score inferred pyramids.
- Note: local dataset is only 11 fragrances / 59 notes — nearly all traffic uses the keyword path.

### A3 — Weather & context inputs
- **GAP1 (High):** Wind never fetched; `wind_speed_mph` always 0 → entire `wind_rule` dead. `weatherService.ts:43`, `weatherServiceCore.ts:54`. Fix: request `wind_speed_10m` (mph), add field, populate.
- **GAP2 (Med-High):** UV captured but dropped at engine boundary. Fix: add `uv_index` to engine input + builders + freshness/wear-window.
- **GAP3 (Med):** `season` never populated. Fix: derive from clock + latitude.
- **GAP4 (Med):** No time-of-day capture. Fix: pass hour, inform wear-window.
- **GAP5 (Med):** `outdoor`/`close_contact` settings unreachable from UI. Fix: expose/map in intent UIs.
- **GAP6 (Med):** Missing-weather fallback uses fixed climate at full confidence; 65°F vs 72°F mismatch. Fix: thread `isLive`/`error`, cap confidence, align defaults.
- **GAP7 (Low-Med):** `is_raining` brittle substring match (misses snow/thunder); no precip amount / feels-like. Fix: pass WMO `weather_code`.
- **GAP8 (Low-Med):** Hardwired °F; London default for no-coords users; timezone label-only. Fix: C/F pref; reconsider default.
- **GAP9 (Low):** Up to ~15 min staleness via layered caches. Fix: optional, document.

### A4 — Data completeness / coverage
- **GAP1 (High):** `api.py:1667` `complete = bn_has_data and (fg_has_data or pf_has_data)` contradicts documented `fg_complete` semantics; partial details read as Complete, halts self-heal. Fix (1 line): `bn_has_data and (fg_complete or pf_has_data)`.
- **GAP2 (High):** Rec `confidence` ignores `source_coverage`/`derived_metrics`. Fix: thread data-confidence, cap when coverage incomplete.
- **GAP3 (Med-High):** `buildOutlookCandidate.confidence` (`present/4`) used by planner only. Fix: fold into primary scoring.
- **GAP4 (Med):** Crowd `wear_profile.primary_seasons` feeds planner only; core engine has no season term. Fix: pass into engine.
- **GAP5 (Low-Med):** `wear_profile.primary_time` (day/night votes) consumed nowhere. Fix: corroborate setting.
- **GAP6 (Med):** Gender votes scraped but dropped from `derived_metrics`. Fix: add `gender_profile` group. No occasion votes exist upstream.
- **GAP7 (Med):** Note-text-fabricated accords counted toward confidence. `WardrobeContext.tsx:429-456`. Fix: only voted `main_accords` raise confidence.
- **GAP8 (Med-High):** Basenotes-only / cold-search produce normal-looking recs with no penalty. Fix: down-weight when `!isSourceCoverageComplete`.

### A5 — Personalization & learning (overall 2/10)
- **GAP1 (High):** Engine `userPreference` hook dead-wired. Fix: add `user_settings` columns, thread through.
- **GAP2 (Critical):** No user taste profile at all (preferred/disliked families, intensity). `userSettings.ts`. Fix: add jsonb columns + term in `scoreFamilyAlignment`.
- **GAP3 (Critical):** `beam_answer_feedback` write-only — no learning loop. `beamAnswerLog.ts:146`. Fix: aggregate reasonCodes back into profile.
- **GAP4 (Med):** Crowd/curation signals never blended into per-user rec.
- **GAP5 (High):** No repetition avoidance; same bottle every similar day. Fix: `lastWornAt` (jsonb, no migration) + recency penalty.
- **GAP6 (Med-High):** No cold-start; empty vault returns early; onboarding captures no taste. Fix: capture liked families, recommend from catalog.
- **GAP7 (Med):** No occasion/context memory. Fix: log accepted (rec, setting) pairs.
- Highest-leverage single addition: a persisted per-user scent-preference profile (GAP2) — the spine for GAP3/4/6/7.

### A6 — Multi-day planning & surfacing
- **GAP1 (High):** Home "today" hero uses snapshot only; forecast day-0 uses planner — two paths can disagree. Fix: derive hero from day-0 planner result.
- **GAP2 (High):** Three divergent scoring formulas (mission `scentMission.ts:511-542` vs home/forecast `WardrobeContext.tsx:790-826`). Fix: promote `dayCandidateScore` into shared engine; all consume it.
- **GAP3 (Med-High):** Only one rec surfaced; ranked runner-ups discarded. Fix: attach top 2-3 alternates.
- **GAP4 (Med):** Home hero "why this" falls back to canned string; richer `describeForecastPick` not reused. Fix: reuse composition.
- **GAP5 (Med):** No "nothing fits today" state; `avoid_today` spun as "a confident statement". Fix: honest no-good-pick state + acquire CTA.
- **GAP6 (Med):** Greedy planner can't reserve a statement scent for its best day. Fix: global day×candidate assignment or per-day weight.
- **GAP7 (Low-Med):** Forecast tiles hide confidence/projection_risk; planner runs on defaulted climate without flagging. Fix: surface confidence; mark defaulted days.

---

## Redesign roadmap (dependency order, minimal surface)

- **Phase 0 — Reconnect what exists** (low risk): pass `userPreference`/`season`/time-of-day/UV into engine input; fetch wind; expose `outdoor`/`close_contact`; re-score on weather change; fix `api.py:1667`.
- **Phase 1 — Honest confidence**: one shared data-confidence signal (source coverage + vector match-ratio + structured-metric coverage) into `calculateConfidence` + display score; vector provenance flag.
- **Phase 2 — Fix the vector (GIGO)**: expand dictionary + consume accords + tokenize + normalize; prefer engine `derived_metrics` when coverage complete.
- **Phase 3 — One source of truth**: promote `dayCandidateScore` into shared engine; runner-ups, real rationale, "nothing fits" state.
- **Phase 4 — Personalization spine + learning**: per-user taste profile; read feedback back; repetition avoidance via `lastWornAt`; cold-start; blend crowd season/time votes.

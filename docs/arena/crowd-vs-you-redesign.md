# Arena game redesign — replace "Scent Rush" with **Crowd vs You**

> Status: proposal / spec (not yet built). Author pass + 4-agent design review incorporated.
> Scope: `artifacts/scent-cast` (SPA), `artifacts/api-server` (Express), `lib/db` (Drizzle), shared Supabase DB.
> This doc is **logically and visually exact against `main` as it stands today** — every file, component, endpoint, table, and CSS token referenced below exists now unless explicitly marked "NEW".

---

## TL;DR

The current Arena mini-game (**Scent Rush**) is a generic 3‑lane endless runner. It never shows a real bottle image, and the chosen fragrance is purely cosmetic — the gameplay is identical no matter what you pick. It's a dexterity game bolted onto a taste/knowledge app.

Replace it with **Crowd vs You**: a daily, blind prediction game played over the Arena's *existing* head‑to‑head battles. On each matchup you make two blind taps — *who's the crowd backing?* and *which would you wear?* — then the live tally is revealed, showing whether you read the crowd right (your **Beam Streak**) and whether your taste matched it. It reuses the battle data and visuals we already ship, keeps the **Beam** branding, centers the real bottle images, and rewards fragrance/social intuition instead of reflexes.

---

# Part A — What it is NOW (Scent Rush)

## A.1 Logical surface (current, on `main`)

**Frontend**
- [artifacts/scent-cast/src/components/arena/ScentRush.tsx](../../artifacts/scent-cast/src/components/arena/ScentRush.tsx) — hero card + full‑screen `RunScreen` runner.
- [artifacts/scent-cast/src/lib/scentRushGame.ts](../../artifacts/scent-cast/src/lib/scentRushGame.ts) — client score preview.
- `scentRushClient.ts` — `startRushRun` / `emitRushEvent` / `completeRushRun` / `getRushProgress` HTTP calls.
- Mounted at the top of [artifacts/scent-cast/src/pages/arena.tsx](../../artifacts/scent-cast/src/pages/arena.tsx#L111), above the real battle stage.
- Fed by `rushFragrances` derived from the wardrobe in [App.tsx](../../artifacts/scent-cast/src/App.tsx#L1302) — only `{fragranceId, name, brand, family, notes}` are passed; **`imageUrl` is dropped**.

**Backend**
- [artifacts/api-server/src/routes/scentRush.ts](../../artifacts/api-server/src/routes/scentRush.ts) — start/complete/progress endpoints.
- [artifacts/api-server/src/services/scentRushCore.ts](../../artifacts/api-server/src/services/scentRushCore.ts) — manifest builder, deterministic event plan, server‑side score validation, anti‑cheat.

**Schema (the two tables pushed 2026‑06‑19)**
- `scent_rush_runs`, `scent_rush_progress` — [lib/db/src/schema/scentRushRuns.ts](../../lib/db/src/schema/scentRushRuns.ts), [scentRushProgress.ts](../../lib/db/src/schema/scentRushProgress.ts), exported from [schema/index.ts](../../lib/db/src/schema/index.ts#L19).

**Cross‑coupling (important for removal)**
- The community feed route **reads `scent_rush_progress`** to compute each fragrance's `beamSupporters` / `totalBeamPower`, which then ride into the battle DTO and the contender cards — [communityPosts.ts:499‑531](../../artifacts/api-server/src/routes/communityPosts.ts#L499-L531). It already degrades to `0` when the table is missing (`isMissingRushTableError`, code `42P01`).

## A.2 Visual surface (current)

- **Hero card** (`ScentRush`): a `max-w-4xl` gold‑bordered `<section>`, headline *"Turn a scent trial into support."*, wardrobe fragrance chips, a **"Play Fresh Start"** primary button, and a right‑hand "Your support — `0 / 2` Beam Power" panel.
- **Run screen** (`RunScreen`, `fixed inset-0 z-[140]`): Score / Beam / Time HUD, a 3‑lane perspective track, and:
  - **Player** = a gold lozenge `bg-[linear-gradient(180deg,#f3d98a,#6f5120)]` with a `<Sparkles>` icon — [ScentRush.tsx:227](../../artifacts/scent-cast/src/components/arena/ScentRush.tsx#L227).
  - **Collectibles** = abstract `✦` orbs with a note label slapped on; hazards `!`; crowd `☺` — [ScentRush.tsx:222](../../artifacts/scent-cast/src/components/arena/ScentRush.tsx#L222).
  - Jump / left / right controls, mute, reduced‑motion toggle.
- **Result modal**: *"Fresh Start complete"*, a big performance `%`, Beam Power earned, best score, notes collected, hazards hit. Replay / Continue.

## A.3 Why it fails (root cause, not taste)

1. **The fragrance is cosmetic, not mechanical.** The lane layout, hazards, and scoring in `generateFreshStartPlan` are identical regardless of scent; the fragrance only renames four orbs — and invents notes (`DEFAULT_NOTES = ["Citrus","Cedar","Amber","Jasmine"]`) when data is missing.
2. **The real bottle never appears.** `imageUrl` isn't even passed in. The "hero" of a fragrance app is absent.
3. **Wrong genre.** Reflex/dexterity expresses nothing about fragrance knowledge or taste.
4. **Hollow meta.** "Beam Power / support" is earned by dodging rain clouds — no connection to supporting a scent.

---

# Part B — What it needs to BE (Crowd vs You)

## B.1 Concept

A standalone Arena mode. One **read** at a time — **two blind taps, then the reveal**:

1. **Blind prompt** — two real bottle cards, community tally **hidden**.
2. **Tap 1 — read the crowd**: *"Who's the crowd backing?"* A bet on the community, not your taste. Locked on tap.
3. **Tap 2 — your own pick**: *"And which would you actually wear?"* Captured **before** the reveal, so it's an honest vote — not a bandwagon echo of a number you just saw.
4. **Reveal** — the live tally bar animates in place, showing both payoffs at once: did you read the crowd right (✓/✗ → **Beam Streak**), and did your taste match the crowd (*"you went with / against the crowd"*).

A **daily set of `CROWD_READ_DAILY_TARGET` reads** (default **3**). Playing keeps your streak alive; skipping a day breaks it. Beam Streak, accuracy %, and best streak are tracked; social compare ("you read the crowd better than X%") is a later add.

## B.2 Design decisions locked by the 4‑agent review

These are not optional polish — each closes a hole a reviewer proved was fatal:

| Decision | Why (which critique) |
|---|---|
| **Serve BLIND** — tally hidden until after the prediction is locked; never serve a battle whose tally the user has already seen revealed. | Integrity + UX: if the tally is visible anywhere, the answer is literally on screen → unscoreable. |
| **Serve only battles with a STABLE, clear leader the user hasn't seen** — `total_votes ≥ CROWD_READ_MIN_VOTES` and margin `≥ CROWD_READ_MIN_MARGIN` (values in B.5). | Integrity: the leader must be a real signal, not noise. At this app's low volume this favours clear leads (stable answers); the narrower "competitive band" that makes the *game* harder is phase‑2, gated on volume. |
| **Stable‑answer eligibility now; closeness‑weighted scoring later.** Tie / no‑clear‑leader = push (no streak change). | Integrity + Game: at *current* low vote volume a close race is an unstable coin‑flip, so we gate on a clear lead and flat‑score it; the "reward tight calls more" curve turns on once typical battles clear ~30 votes (B.5). |
| **Daily curated set of `CROWD_READ_DAILY_TARGET`**, streak breaks on a skipped day. | Game: one‑shot‑per‑battle + min‑votes gate empties the pool in one session; scarcity is the return hook. |
| **"Crowd vs You" — both picks captured BLIND** (read‑the‑crowd tap + your‑own‑pick tap, *then* reveal). The own‑pick is a required real vote. | Game + UX + cold‑start + integrity: generates real votes (breaks the read‑only chicken‑and‑egg) and is a taste‑mirror — but capturing your vote *before* the tally is shown is what stops it polluting the very tally future players read (no post‑reveal bandwagon). |
| **Separate mode, not woven into the live vote flow.** | UX: one set of cards can't mean "my favorite" and "who's winning" in the same scroll without misfiring muscle memory and polluting vote analytics. |
| **Distinct "bet" chrome** on the prediction cards (prompt header, bet‑marker on tap, never a vote tick). | UX: reuse the components, change the *frame* so prediction ≠ voting at the point of action. |

## B.3 Logical spec

### Data model (NEW)

Replaces `scent_rush_runs` + `scent_rush_progress`.

```sql
-- one row per scored read; idempotent per (user, battle)
create table public.arena_crowd_predictions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  user_id         uuid not null references public.users(id) on delete cascade,
  post_id         uuid not null references public.community_posts(id) on delete cascade,
  predicted_choice text not null,   -- tap 1: who you bet the crowd backs
  own_pick        text not null,    -- tap 2: your real vote (also written to community_votes)
  leader_at_reveal text,            -- null = no clear leader (push)
  tally_total_at_reveal integer not null,
  was_correct     boolean not null,
  streak_after    integer not null, -- streak value immediately after this read (O(1) reads, replayable)
  created_at      timestamptz not null default now(),
  unique (user_id, post_id)
);

-- denormalized hot-path stats (avoid scanning all rows for best-streak/accuracy)
create table public.arena_crowd_stats (
  tenant_id      uuid not null references public.tenants(id),
  user_id        uuid not null references public.users(id) on delete cascade,
  current_streak integer not null default 0,
  best_streak    integer not null default 0,
  total_reads    integer not null default 0,
  correct_reads  integer not null default 0,
  last_played_on date,              -- drives "skip a day breaks streak"
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
```

`streak_after` per row + a `stats` upsert was the architecture agent's explicit recommendation: deriving best‑streak on the fly means scanning every row, ordered, on each fetch.

### Endpoints

- **Playable set** — extend the existing feed, don't add a fetcher:
  `GET /community/posts?type=battle&playable=1`
  Add a SQL `HAVING` clause: `total ≥ CROWD_READ_MIN_VOTES` AND `abs(leftCount − rightCount) ≥ CROWD_READ_MIN_MARGIN` so only stable‑answer battles reach the client. Exclude battles the viewer has already revealed (their own `community_votes` row exists, or a prior `arena_crowd_predictions` row exists). Return the battles **without** the tally for `playable=1` (blind). Cap to `CROWD_READ_DAILY_TARGET`.
- **Submit read** — NEW `POST /community/posts/:id/crowd-read { predicted_choice, own_pick }` (both taps arrive together, before any reveal):
  - In a single transaction: re‑read the live `community_votes` tally (server authority — never trust client); compute `leader_at_reveal` + `was_correct` + the new streak; **write the `own_pick` to `community_votes`** (the real, required vote) via the same upsert the vote endpoint uses; upsert the `arena_crowd_predictions` row (`UNIQUE(user,post)` → idempotent: return the existing row, don't re‑score) and `arena_crowd_stats`.
  - No clear leader at submit (margin `< CROWD_READ_MIN_MARGIN`) → `leader_at_reveal = null`, push (streak unchanged). With the eligibility gate this is a rare race (a vote landing between serve and submit), not a normal case.
  - Response: `{ was_correct, leader_at_reveal, tally, went_with_crowd, current_streak, best_streak, accuracy }` — `tally` is the reveal payload, `went_with_crowd = own_pick === leader_at_reveal`.

### Scoring rules

- Correct read = `predicted_choice === leader_at_reveal`. Correct → `+1` Beam Streak (flat at launch); wrong → streak resets to 0; push → streak unchanged.
- **Closeness‑weighting is phase 2** (B.5): only meaningful once close races are *stable*, i.e. once typical battles clear ~30 votes. Until then scoring is flat.
- One scored attempt per (user, battle). No re‑roll: the daily set is a fixed queue.

### Removal blast radius (Scent Rush) — **code‑first, drop‑tables‑last**

Removing tables before the code typechecks is the trap. Sequence:

1. **Additive first (zero risk):** add `arena_crowd_predictions` + `arena_crowd_stats`; ship read/submit path. Live feed untouched.
2. **Then remove code in one typecheck‑clean commit:**
   - delete `ScentRush.tsx`, `scentRushGame.ts`, `scentRushClient.ts`, `routes/scentRush.ts`, `scentRushCore.ts` (+ tests);
   - unmount `<ScentRush>` in `arena.tsx`, drop `rushFragrances` in `App.tsx`;
   - **repoint, don't delete,** the `beamSupporters`/`totalBeamPower` read in `communityPosts.ts:499‑531` from `scent_rush_progress` to the new `arena_crowd_*` source (Beam branding stays — B.6). The DTO, `ArenaBattleSide` fields, and frontend types are **unchanged**; only the query underneath moves. This keeps the battle cards' Beam stats alive and avoids a typecheck cascade.
   - remove `scentRushRuns`/`scentRushProgress` from `schema/index.ts`.
3. **Drop the two tables LAST**, after the read‑free code is deployed (use the same additive‑migration runner pattern; never `drizzle push`).

## B.4 Visual spec (reuse what exists)

**Placement.** Replace the `<ScentRush>` hero at [arena.tsx:111](../../artifacts/scent-cast/src/pages/arena.tsx#L111) with a **Crowd vs You** entry card in the same slot (same `max-w-4xl`, gold‑bordered, `font-serif` headline, `scent-type-label` accents) so the page rhythm is unchanged. Tapping it opens the mode.

**Two blind taps (no reveal yet).** Reuse `ArenaBattleSide` (the contender card with the real bottle image) inside the same `grid-cols-[minmax(0,1fr)_2.75rem_minmax(0,1fr)]` "VS" layout from `ArenaBattleStage`, tally hidden. Differentiate the *frame*, not the component — a persistent prompt header carries the verb and the meta:
- **Tap 1 — read the crowd:** header reads **"CROWD FAVORS? · Beam Streak N"**; on tap, show a **bet‑marker** ("You bet: A") — explicitly **not** the gold vote `<Check>` tick used by real voting.
- **Tap 2 — your pick:** header swaps to **"AND YOU — WHICH WOULD YOU WEAR?"**; this tap *does* use the familiar vote treatment (it is the real, required `useCommunityBattleVote`). Both taps land while the tally is still hidden.

**Reveal (in place, no scroll).** Only after both taps: animate the existing tally bar from `ArenaResultReveal` (the `flex h-4 rounded-full bg-scent-accent/8` two‑segment bar + `arenaPercentFor`) directly under the same two cards. Show **two payoffs at once** — crowd read ✓/✗ → Beam Streak, and a *"you went with / against the crowd"* badge (the taste‑mirror). "Next" lands under the thumb; the result expands in place — no scrolling to it and back up.

**Streak HUD.** A small persistent chip (**Beam Streak** / today's reads remaining, e.g. `2/3`) reusing `scent-type-chip` styling. When the daily set is exhausted — or when fewer than `CROWD_READ_DAILY_TARGET` battles qualify — show the honest empty state: *"That's all the crowd's settled on today. Check back as votes come in."*

**Theme.** Unchanged: gold `scent-accent` on near‑black, `font-serif` headings, existing radii/shadows. Honor the workspace ban on projected gold glow under surfaces (see `no-projected-gold-glow`).

## B.5 Resolved parameters

Tuned for this app's **current reality**: a young fragrance community, **not yet at traffic**, so battle vote counts are low (single to low‑double digits). The values below are deliberately *small* so the game is playable on day one, and they tighten automatically as volume grows. All are named constants in one config module so they're trivially raised later.

| Constant | Launch value | Why this value |
|---|---|---|
| `CROWD_READ_MIN_VOTES` | **8** | Below ~8 votes a "winner" is noise. 8 is low enough that even a young room has qualifying battles, yet high enough that a clear lead carries signal. |
| `CROWD_READ_MIN_MARGIN` | **`max(2, ceil(0.15 × total))`** | The lead must be *stable*: at tiny N you need at least a 2‑vote gap; as N grows you need ≥15% separation, so one new vote can't flip the "answer" between serve and submit. |
| `CROWD_READ_DAILY_TARGET` | **3** | A 3‑read micro‑session mirrors the fragrance world's daily "scent‑of‑the‑day" ritual, is shareable ("3/3 today"), and won't drain a thin battle inventory. Serve fewer when fewer qualify. Raise toward 5 as the room grows. |
| Own‑pick (real vote) | **Required, captured blind** | At this scale the game must double as the vote‑acquisition engine, so the own‑pick is required — but taken *before* the reveal so it can't become a bandwagon echo. (Relaxable to skippable via a flag if friction shows up.) |
| Closeness‑weighted scoring | **Phase 2** (flat +1 now) | A "reward tight calls more" curve only makes sense once close races are *stable* — i.e. once typical battles clear ~30 votes. Until then: correct read = +1 Beam Streak, flat. Flip on by tightening eligibility to a competitive band (e.g. 55–70% leader) once volume supports it. |
| Beam branding | **Kept** | Owner decision. See B.6. |

**Why daily + curated, not endless:** scarcity is the return hook, and a daily cap throttles how fast a small battle inventory burns. The streak is therefore a **daily** streak (play today to keep it) — the sticky mechanic. (Streak basis = daily‑calendar, via `arena_crowd_stats.last_played_on`.)

**Cold‑start is handled, not hand‑waved:** pre‑traffic, some days will have **0–2** qualifying battles. The mode degrades gracefully (serve what exists, never a fabricated or blowout battle, show the honest empty state) — and because the own‑pick is a required real vote, *playing the game is what grows the vote volume the game feeds on.* It bootstraps itself.

## B.6 Beam economy (retained — Beam branding stays)

The runner is gone, so the `beam`/Beam vocabulary is **re‑sourced** from Crowd vs You instead of `scent_rush_progress`:

- **Beam Power (per user × fragrance)** — earned when you back a fragrance with your blind own‑pick in a read. The per‑fragrance signal that already feeds the battle card.
- **Beam Supporters (per fragrance)** — distinct users who've beam‑backed it. **This is the existing `beamSupporters` field on `ArenaBattleSide`**, kept verbatim in the UI, just computed from the new source (own‑pick votes in `community_votes`, joined to the battle's fragrance snapshot).
- **Total Beam Power (per fragrance)** — existing `totalBeamPower` field, likewise repointed.
- **Beam Streak (per user)** — NEW: consecutive correct crowd‑reads; the daily hook shown in the mode header and result, backed by `arena_crowd_stats`.

Net effect: the battle cards keep showing "Beam Supporters / Total Beam Power" with **no visual change**, but those numbers now mean *real community backing* (honest blind votes) instead of *runner scores*.

---

## Appendix — exact `main` references

- Arena page / mount point: `artifacts/scent-cast/src/pages/arena.tsx`
- Battle stage + cards: `arena/ArenaBattleStage.tsx`, `arena/ArenaBattleSide.tsx`
- Reveal/tally visuals: `arena/ArenaResultReveal.tsx`, `arena/arenaTwists.ts` (`arenaVoteTotal`, `arenaPercentFor`)
- Battle data mapping: `arena/arenaBattleMapper.ts`
- Vote/tally backend: `api-server/src/routes/communityPosts.ts` (feed `buildPostDtos`, vote `POST /community/posts/:id/votes`)
- Scent Rush to remove: `arena/ScentRush.tsx`, `lib/scentRushGame.ts`, `routes/scentRush.ts`, `services/scentRushCore.ts`, `schema/scentRush*.ts`

# Arena → Beam Power + Snake Game: Implementation Plan

## Context

The Arena page currently leads with a "Daily Ritual / Crowd vs You / Beam Streak"
block (the lineage of the old "Scent Rush" experience). The owner wants this
removed entirely and the page refocused on the head-to-head battle. Below each
contender's **Supporters / Beam Power** stats, a refined **"Add Beam Power"**
button should let users earn Beam Power for a fragrance by completing a small,
beautifully baked-in **"Scent Beam" snake game**. Beam Power is a *showcase*
signal ("I love this fragrance") — it must **never** feed the fragrance's
community rating. Two existing defects are folded in: cards show **"Unknown
Family"** for fragrances we have data for, and the obsolete ritual block must
go.

This plan is written to be executed in a single implementation pass.

### Decisions (confirmed with owner)
- **Family fix:** show the *real* family — sanitize placeholders AND derive the
  true family from the fragrance detail when the snapshot's is missing/placeholder.
- **Beam reward:** **score-based** — Beam Power earned scales with the snake run
  score (still fully separate from ratings, so no bloat to community rating).
- **Save action:** **not** in scope — keep arena on Vote + Beam Power.

### Key findings from investigation
- `arena.tsx:111` renders `<CrowdVsYou>`; that component (`CrowdVsYou.tsx`) is the
  entire ritual block. The `ArenaBattleStage` below it stays.
- **Beam Power/Supporters today are derived from `arena_crowd_predictions`**
  (the very feature we're removing) — `communityPosts.ts:509-551`. They need a
  **new source** tied to the snake game.
- **No rating-inflation risk:** Beam Power/Supporters are pure counters, fully
  separate from the external Fragrantica/Basenotes rating system.
- **"Unknown Family"** leaks because `arenaBattleMapper.ts:51` renders
  `fragrance.family` raw, skipping the existing `sanitizeFamilyLabel()`
  (`wardrobeSearchSuggest.ts:32`) the community feed already uses.
- No existing snake/canvas game. Reusable input patterns exist:
  `ArenaBattleSide.tsx` (pointer tap-vs-scroll), `useMarqueeSwipe.ts`
  (pointer + RAF + velocity), `NotePyramid.tsx` (keydown capture).

---

## Part A — Remove the ritual ("Crowd vs You" / Scent Rush) block

**Files:** `artifacts/scent-cast/src/pages/arena.tsx`

1. Delete the `<CrowdVsYou>` render and its wrapper `<div>` (`arena.tsx:110-112`)
   and the import (`arena.tsx:6`). The page then opens directly on
   `ArenaBattleStage` after the top nav.
2. Remove the now-orphaned UI files **only after** confirming no other importers
   (grep first): `components/arena/CrowdVsYou.tsx`,
   `components/arena/CrowdReadBattleSide.tsx`, `lib/arenaCrowdReadClient.ts`, and
   `components/arena/ScentRush.tsx` if present and unimported.
3. **Backend stays intact** — leave the `/crowd-read` route and
   `arena_crowd_predictions` / `arena_crowd_stats` tables (non-destructive; just
   dormant). Beam Power aggregation is repointed in Part C, so removing the UI
   does not break card stats.

## Part B — New Beam Power data model (snake-earned)

**New schema file:** `lib/db/src/schema/arenaBeamGrants.ts`, exported from
`lib/db/src/schema/index.ts` (Drizzle picks it up via the `./src/schema/*.ts`
glob).

Table `arena_beam_grants`:
- `id` uuid pk, `tenantId` text, `userId` uuid/text (FK to users), `postId` text,
  `fragranceId` text (the snapshot `fragranceId`, e.g. `catalog:brand:name`),
  `beamPower` integer (score-derived), `gameScore` integer, `createdAt` timestamp.
- Indexes on `(tenantId, fragranceId)` for the aggregation join.
- No unique constraint on `(userId, fragranceId)` — replays add Beam Power;
  Supporters use `count(distinct userId)` so they don't double-count.

Run guarded push after schema lands: `pnpm --filter @workspace/db run push`
(see CLAUDE.md `ALLOW_PROD_DB_PUSH` guard for non-local DBs).

## Part C — Backend: beam endpoint + repointed aggregation

**File:** `artifacts/api-server/src/routes/communityPosts.ts`

1. **New endpoint** `POST /api/community/posts/:id/beam` (mirror the auth + Zod
   validation style of the existing `/votes` and `/crowd-read` handlers):
   - Requires `Authorization: Bearer` (signed-in only).
   - Body `{ choice: string, score: number }`; validate `choice` is one of the
     post's two `metadata.options`; resolve the matching contender `fragranceId`
     via `community_post_fragrances` (same position-mapping logic already used at
     `communityPosts.ts:531-535`).
   - Server-side anti-abuse: clamp `score` to a sane max, require a minimum
     (the game target) before a grant counts, and derive `beamPower` from the
     clamped score (e.g. `beamPower = clamp(floor(score / STEP), 1, MAX)`).
   - Insert one `arena_beam_grants` row; return the refreshed
     `{ supporters, totalBeamPower }` for that `fragranceId`.
2. **Repoint aggregation** in `buildPostDtos` (`communityPosts.ts:509-551`):
   read from `arena_beam_grants` instead of `arena_crowd_predictions` —
   `supporters = count(distinct userId)`, `totalBeamPower = sum(beamPower)`,
   grouped by `fragranceId`. Keep the missing-table try/catch guard so the feed
   degrades to zeros if the table isn't pushed yet.
3. **Do not touch** any rating field — there is none in these tables; the
   external rating system stays untouched, satisfying the no-bloat rule.

**Tests:** add a case to the api-server test suite (Node built-in runner)
covering: valid grant increments supporters/beam, below-target score rejected,
choice not in options rejected, repeat play by same user keeps Supporters flat
but raises Beam Power.

## Part D — Frontend: Beam client + "Add Beam Power" button

**New file:** `artifacts/scent-cast/src/lib/arenaBeamClient.ts` — `submitBeamPower({ postId, choice, score }, token)` POSTing to the new endpoint (follow `arenaCrowdReadClient.ts` request style and `normalizeApiBaseUrl`).

**Hook:** add `useSubmitBeamPower(token)` (React Query mutation) in
`components/community/communityPosts.ts` alongside `useCommunityBattleVote`;
on success, optimistically bump the active battle side's `beamSupporters` /
`totalBeamPower` in the cached community posts and invalidate to reconcile.

**Button:** in `components/arena/ArenaBattleSide.tsx`, add a compact, on-brand
**"Add Beam Power"** button **directly under** the Supporters/Beam Power stat
grid (after line 212). Style to match the existing gold button language
(reuse the `Sparkles`/gold token classes already in the file; **no projected
gold glow** per the `no-projected-gold-glow` rule — inset/hairline shadows only).
Wire a new `onAddBeamPower` prop up through `ArenaBattleStage` to open the game
overlay for that contender. Disabled (with a "Sign in" affordance) for guests.

## Part E — The "Scent Beam" snake game (baked-in overlay)

**New file:** `artifacts/scent-cast/src/components/arena/ArenaBeamGame.tsx`
(plus a small pure-logic module `arenaBeamGameCore.ts` for grid/step/collision so
it is unit-testable). Rendered as a `Dialog`/overlay from `ArenaBattleStage`,
themed to the arena (dark glass panel, gold accents, the contender's bottle/name
as the prize motif).

Mechanics:
- Grid-based snake on a fixed logical board scaled to the panel; movement via
  `requestAnimationFrame` with a fixed tick; respect `prefers-reduced-motion`
  (reuse the project's reduced-motion/render-budget patterns).
- **Mobile:** swipe to steer — adapt the pointer + `TAP_MOVE_TOLERANCE_PX`
  /direction logic from `ArenaBattleSide.tsx`/`useMarqueeSwipe.ts`; set
  `touch-action: none` on the board so swipes don't scroll the page.
- **PC:** Arrow keys / WASD via a `keydown` capture listener (mirror
  `NotePyramid.tsx`). Show a subtle "Use arrow keys" hint **only** when
  `matchMedia('(pointer: fine)')` matches — never on touch.
- **Win/grant:** reaching the target score unlocks "Claim Beam Power", which
  calls `useSubmitBeamPower` with the run score, then animates the
  Supporters/Beam Power increment on the card and closes. Score below target =
  retry, no grant. Keep transitions smooth and seamless; no layout jank when the
  overlay opens/closes.

**Tests:** unit-test `arenaBeamGameCore.ts` (move, grow on food, wall/self
collision, score accrual).

## Part F — Fix "Unknown Family" (show the real family)

1. **Stop the placeholder leak (display):** in
   `components/arena/arenaBattleMapper.ts:51`, run the family through
   `sanitizeFamilyLabel()` (`lib/wardrobeSearchSuggest.ts:32`) before using it as
   the descriptor; keep the `'Classic fragrance' / 'Community option'` fallback
   only when no real family is available.
2. **Stop storing placeholders (capture):** apply `sanitizeFamilyLabel()` to the
   `family` captured in `components/community/PostComposer.tsx` (lines 185, 248,
   265, 706) so future battles never persist `"Unknown Family"`.
3. **Show the real family (enrichment):** add a small hook (e.g.
   `useArenaContenderFamilies`) that, for the active battle's two contenders,
   when the snapshot family is absent/placeholder, fetches the detail via the
   SPA's canonical `lib/fragranceApi.ts:getFragranceDetails` (build the payload
   from the snapshot `fragranceId`/name/brand; `catalog:` ids route to the local
   Express API), extracts `detail.family` (sanitized; fall back to deriving from
   primary accord if `family` is empty), and feeds it into the card descriptor and
   `ArenaCompareDialog`. Cache by `fragranceId` via React Query; render the
   snapshot value first and upgrade on arrival (no spinner flash).

---

## Verification

1. `pnpm run typecheck` then `pnpm run build` (whole workspace).
2. `pnpm --filter @workspace/api-server run test` (beam endpoint cases) and the
   new `arenaBeamGameCore` unit tests.
3. Push the new table: `pnpm --filter @workspace/db run push` (guarded).
4. Run locally: `pnpm --filter @workspace/api-server run dev` +
   `pnpm --filter @workspace/scent-cast run dev`. Manually confirm:
   - Arena opens straight to the battle — no Daily Ritual / Crowd vs You block.
   - Contender cards show the **real** scent family (no "Unknown Family").
   - "Add Beam Power" sits cleanly under the stats; opens the snake overlay.
   - Snake is swipe-controlled on a phone (no page scroll) and arrow/WASD on PC,
     with the keyboard hint visible only on PC.
   - Reaching target score grants score-based Beam Power: Supporters +1 for a
     first-time supporter, Beam Power rises; replay raises Beam Power but not
     Supporters.
   - Confirm the fragrance's community rating is unchanged by Beam Power.
5. Responsive check on PC / iPad / iPhone / 320px per house rules.

## Risks / notes
- Repointing Beam Power to `arena_beam_grants` resets displayed totals to 0 until
  users play — expected for a brand-new mechanic.
- The beam endpoint trusts the client's reported score; mitigated by min/max
  clamping. Server cannot fully verify gameplay (acceptable for a showcase
  signal that never touches ratings).
- Family enrichment adds detail fetches for the two active contenders only
  (cached) — keep it lazy to the active battle to avoid fanning out the feed.

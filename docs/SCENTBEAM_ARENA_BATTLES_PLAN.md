# ScentBeam Arena Battles Plan

Date: 2026-06-11

## Purpose

This document turns the ScentBeam Arena concept into a repo-specific planning brief for the current ScentBeam web application. It is intentionally written as a living handoff file for future agents: first understand the existing community/battle implementation, then evolve it into a focused, high-visual, viral battle experience without overbuilding forum functionality.

Confidence rule for this document: statements in **Confirmed Current Implementation** are based on inspected files in this repository. Anything under **Proposed** or **Open Questions** is a product/design recommendation, not a claim about existing code.

## Source Concept

The latest attached concept is:

`C:\Users\urban\.codex\attachments\03652be9-9c48-405d-a5e0-12f2ead47f6f\pasted-text.txt`

Core thesis from that concept:

> ScentBeam Arena is a fast fragrance judgment game. Users land on one scenario, pick which fragrance wins, see how their taste compares to the crowd, get one surprising result twist, and continue into the next battle.

Target loop:

`Land -> Vote -> Reason -> Reveal -> Compare -> Continue`

The important product shift is that battles should not feel like generic forum polls. They should feel like a live judgment game: one provocative matchup, one tap, one optional reason, one reveal, one twist, one next battle.

## Related Files To Inspect First

Frontend route and page shell:

- `artifacts/scent-cast/src/App.tsx`
- `artifacts/scent-cast/src/pages/community.tsx`

Frontend community/battle UI:

- `artifacts/scent-cast/src/components/community/communityPosts.ts`
- `artifacts/scent-cast/src/components/community/PostCard.tsx`
- `artifacts/scent-cast/src/components/community/PostComposer.tsx`
- `artifacts/scent-cast/src/components/community/CommunityFeed.tsx`
- `artifacts/scent-cast/src/components/community/PostFilters.tsx`
- `artifacts/scent-cast/src/components/community/CommunityHero.tsx`
- `artifacts/scent-cast/src/components/community/ReactionBar.tsx`
- `artifacts/scent-cast/src/components/community/CommentThread.tsx`
- `artifacts/scent-cast/src/components/community/BottleMarquee.tsx`
- `artifacts/scent-cast/src/components/community/CommunityFragranceCard.tsx`
- `artifacts/scent-cast/src/components/community/CommunityFragranceOverlay.tsx`
- `artifacts/scent-cast/src/index.css`

Backend API:

- `artifacts/api-server/src/routes/communityPosts.ts`
- `artifacts/api-server/src/routes/community.ts`
- `artifacts/api-server/src/routes/index.ts`
- `artifacts/api-server/src/middlewares/auth.ts`
- `artifacts/api-server/src/middlewares/tenant.ts`

Database schema:

- `lib/db/src/schema/communityPosts.ts`
- `lib/db/src/schema/communityVotes.ts`
- `lib/db/src/schema/communityComments.ts`
- `lib/db/src/schema/communityReactions.ts`
- `lib/db/src/schema/communityPostFragrances.ts`
- `lib/db/src/schema/communityTags.ts`
- `lib/db/src/schema/index.ts`

## Confirmed Current Implementation

### Routing

Current app routes expose `/community`, `/share/:userId`, `/debug/ipad-freeze`, `/`, and fallback `*`. There is no inspected frontend route for `/community/posts/:id`, `/community/battles/:id`, or `/arena` yet.

Relevant file: `artifacts/scent-cast/src/App.tsx`.

### Community Page Structure

The community page currently renders:

- `AppTopNav`
- `CommunityHero`
- full-bleed `BottleMarquee`
- a forum panel containing `PostComposer` and `PostFilters`
- `CommunityFeed`
- footer

The community feed is delayed until after initial route paint through `useAfterInitialRoutePaint`, with a `COMMUNITY_BODY_WAKE_DELAY_MS` of 640ms.

Relevant file: `artifacts/scent-cast/src/pages/community.tsx`.

### Post Types

The frontend and backend both support these community post types:

- `question`
- `sotd`
- `battle`
- `worth_it`

Relevant files:

- `artifacts/scent-cast/src/components/community/communityPosts.ts`
- `artifacts/api-server/src/routes/communityPosts.ts`
- `lib/db/src/schema/communityPosts.ts`

### Current Battle Data Shape

Today, a battle is a normal `community_posts` row with `post_type = 'battle'`.

Battle options are stored inside `community_posts.metadata` as:

```json
{
  "options": ["Option A", "Option B"]
}
```

The backend validates that battle metadata contains exactly two non-empty string options under 80 characters.

Relevant files:

- `artifacts/api-server/src/routes/communityPosts.ts`
- `lib/db/src/schema/communityPosts.ts`

### Current Vote Data Shape

Votes live in `community_votes` with:

- `tenant_id`
- `post_id`
- `user_id`
- `choice`
- timestamps

There is a unique index on `(user_id, post_id)`, so one signed-in user can have one current choice per battle post. The vote endpoint uses an upsert, so changing a vote updates the same row.

There is no confirmed anonymous vote storage, vote reason storage, session identity storage, demographic slice, taste profile, or twist table in the inspected schema.

Relevant file: `lib/db/src/schema/communityVotes.ts`.

### Current Battle Creation UX

`PostComposer` lets signed-in users create a battle by selecting the `Battle` room type, entering:

- optional room title
- tags
- required body
- `Option A`
- `Option B`
- up to three attached catalog fragrance snapshots

If the viewer is not signed in, post creation triggers sign-in. The composer builds battle metadata from `battleA` and `battleB`.

Relevant file: `artifacts/scent-cast/src/components/community/PostComposer.tsx`.

### Current Battle Display UX

`PostCard` handles every post type. For battle posts it renders `BattleVotes`.

Current battle voting behavior:

- Extracts exactly two options from `post.metadata.options`.
- Computes total votes from `post.votes`.
- Before the viewer votes, the UI labels each button with the raw count.
- After the viewer votes, the UI labels each option with percentage and count.
- The viewer's selected option gets a `Your pick` pill.
- If the viewer is logged out and taps a vote, the app opens sign-in and stores the pending choice for replay after auth.
- Vote save uses `useCommunityBattleVote`.

Current battle cards still include generic forum elements:

- author header
- post type pill
- title/body
- reactions
- comments toggle
- optional attached fragrance showcase
- tags

Relevant file: `artifacts/scent-cast/src/components/community/PostCard.tsx`.

### Current Feed Behavior

`CommunityFeed` renders post cards in an infinite feed. It supports filtered empty states and a load-more sentinel. Battles are only one filter/category inside this generic feed.

Relevant files:

- `artifacts/scent-cast/src/components/community/CommunityFeed.tsx`
- `artifacts/scent-cast/src/components/community/PostFilters.tsx`

### Current API Behavior

Community read endpoints are public with optional auth:

- `GET /api/community/posts`
- `GET /api/community/posts/:id`

Optional auth lets the backend include the viewer's reactions and battle vote when available.

Community mutations require auth:

- `POST /api/community/posts`
- `POST /api/community/posts/:id/comments`
- `POST /api/community/reactions`
- `POST /api/community/posts/:id/votes`

The vote endpoint:

- requires a UUID post id
- requires `choice`
- verifies the post exists
- rejects voting on non-battle posts
- validates `choice` against the two metadata options when the metadata is well-formed
- upserts into `community_votes`
- returns `{ postId, choice, votes }`

Relevant file: `artifacts/api-server/src/routes/communityPosts.ts`.

### Current Detail Endpoint Exists, But No Confirmed Detail Route

The backend has `GET /api/community/posts/:id`, returning `{ post, comments }`. The frontend has `fetchCommunityPostDetail` and `useCommunityPostDetail`, currently used by `CommentThread` after comments are opened.

I did not find an inspected frontend route that presents a community post or battle as its own page. That is a key gap for the requested direction.

Relevant files:

- `artifacts/api-server/src/routes/communityPosts.ts`
- `artifacts/scent-cast/src/components/community/communityPosts.ts`
- `artifacts/scent-cast/src/components/community/CommentThread.tsx`

## Current Implementation Compared To Arena Concept

| Area | Current Implementation | Arena Concept Need |
| --- | --- | --- |
| Entry point | `/community` generic forum feed | Dedicated battle/arena page or detail route |
| First screen | Hero, marquee, composer, filters, feed | One featured battle immediately visible |
| Battle model | Post subtype with two text options in metadata | Scenario-driven matchup with structured fragrance sides |
| Vote friction | Auth required for saved vote | Anonymous first-tap voting preferred |
| Vote reason | Not stored | Optional one-tap reason after vote |
| Result reveal | Percent/count after voted | Winner, percentage, reason breakdown, twist insight |
| Twist mechanic | Not present | Required MVP mechanic |
| Next battle | Feed scrolling/load more | Explicit `Next Battle` loop |
| Taste identity | Not present in community battle flow | Light tags after several votes |
| Comments | Generic comments available per post | De-emphasize or hide until later |
| Visual feel | Elegant community forum card | High-impact game/judgment page |
| Share result | Not confirmed for battle result cards | Shareable result card desired |
| Individual pages | API detail exists, frontend route not found | Battle pages and eventually all forum posts need pages |

## Product Direction

### Recommended Naming

Use **Arena** as the main product surface.

Suggested UI language:

- `Settle This`
- `Vote`
- `Defend Your Pick`
- `Reveal`
- `Next Battle`

Avoid foregrounding words like `poll`, `survey`, or `forum` in the battle experience.

### Recommended MVP Experience

The MVP should be visually complete and interaction-light:

1. User opens `/arena` or `/community/battles/:id`.
2. One battle fills the first viewport.
3. User sees scenario context, not a list of categories.
4. User taps one fragrance side.
5. User optionally taps one reason.
6. Result reveal shows winner percentage.
7. Result reveal shows one twist.
8. User gets a light taste tag.
9. User taps `Next Battle`.
10. Below/after first vote, the page may show more battle rails.

Do not start with:

- full comments as primary content
- user-created battle tools as the first screen
- leaderboards
- badges
- complex profile pages
- heavy filters
- demographic forms

### Visual Standard

The Arena should feel more like an interactive product/game surface than a forum post card.

Recommended visual direction:

- One full-width battle stage.
- Two large fragrance cards facing off.
- Strong scenario header: moment, weather, social context, risk.
- Bottle images should be prominent and inspectable.
- Vote buttons should be obvious, large, and thumb-friendly.
- Result reveal should animate or at least visually transform the stage after vote.
- The twist should be a designed content block, not a paragraph buried below counts.
- Hide comments and generic post actions from the first Arena MVP unless explicitly opened later.

Current visual assets/patterns to reuse:

- Bottle image rendering conventions in `BottleImage.tsx`, `CommunityFragranceCard.tsx`, and `PostCard.tsx`.
- Existing dark/gold ScentBeam brand language in `index.css`.
- Existing top navigation and route transition shell from `App.tsx`.

## Proposed Technical Plan

### Phase 1: Route And Page Skeleton

Add a dedicated route while keeping `/community` intact.

Recommended routes:

- `/arena` for the fast featured battle loop.
- `/community/battles/:id` for a specific battle page.
- Later: `/community/posts/:id` for non-battle post pages.

Pragmatic first route choice:

- Build `/arena` first if the goal is viral loop discovery.
- Build `/community/battles/:id` first if the goal is direct links from existing battle cards.

The app already lazy-loads `CommunityPage`, so a similar lazy page can be added for Arena.

### Phase 2: Shared Battle DTO

Do not force future Arena UI to parse generic `metadata.options` forever. Add a typed mapper in frontend code that converts current `CommunityPost` battle posts into an Arena-friendly shape.

Example frontend type:

```ts
interface ArenaBattle {
  id: string;
  title: string;
  scenario: string;
  context: string;
  left: ArenaBattleSide;
  right: ArenaBattleSide;
  votes: Record<string, number>;
  viewerVote: string | null;
}

interface ArenaBattleSide {
  key: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  descriptors: string[];
}
```

For current posts, `left.key` and `right.key` can initially be the two option strings. If attached fragrance snapshots exist, map the first two snapshots onto the two sides by position.

### Phase 3: Data Model Additions For Arena

Current schema can support basic voting, but the Arena concept needs more structured data.

Recommended additions, either as new tables or carefully versioned metadata:

- Battle scenario fields:
  - `scenario_title`
  - `scenario_context`
  - `temperature_context`
  - `occasion`
  - `visibility_status`
  - `featured_rank`
  - `starts_at`
  - `ends_at`
- Side fields:
  - side key
  - fragrance name
  - brand
  - image URL/object id
  - short descriptor copy
- Vote reason fields:
  - selected side
  - reason key
  - optional ownership signal such as `own_both`, if intentionally collected
- Twist fields:
  - twist type
  - headline
  - supporting copy
  - source rule/segment

Recommended database direction:

- Keep `community_posts` as the parent object if battles must remain compatible with community/forum infrastructure.
- Add an `arena_battle_details` table if Arena needs structured queryability.
- Add `reason` and anonymous/session support to votes only after deciding privacy and anti-abuse rules.

### Phase 4: Anonymous Voting Decision

The concept explicitly benefits from no-login-first voting. Current implementation requires auth for vote persistence.

Recommended MVP compromise:

- Allow a local, instant client vote for guests so the reveal happens immediately.
- Persist authenticated votes with the existing endpoint.
- For guests, either:
  - delay server persistence until sign-in, or
  - add anonymous/session voting intentionally with anti-abuse controls.

Do not silently pretend guest votes are globally counted unless they are actually persisted.

### Phase 5: Twist Engine

Start deterministic, not AI-generated at runtime.

Minimum viable twist examples:

- Overall winner differs from reason winner.
- Option A wins `projection`, option B wins `safer choice`.
- Low total vote fallback: editorial twist copy instead of fake segmentation.

Possible reason keys:

- `more_attractive`
- `safer_choice`
- `better_projection`
- `better_weather_fit`
- `more_unique`
- `better_value`
- `i_know_both`

The first version can compute twists from vote/reason counts. Avoid fake claims like "owners picked X" unless ownership was actually collected.

### Phase 6: Share Result Card

The result card should be designed as a compact viral artifact:

- Scenario title
- Winner and percentage
- User's pick
- Twist
- ScentBeam Arena branding

Implementation options:

- First: native Web Share/text link.
- Later: generated image card.

## Proposed Frontend Components

Likely new files:

- `artifacts/scent-cast/src/pages/arena.tsx`
- `artifacts/scent-cast/src/pages/community-battle.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaBattleStage.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaBattleCard.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaReasonPicker.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaResultReveal.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaNextRail.tsx`
- `artifacts/scent-cast/src/components/arena/arenaBattleMapper.ts`
- `artifacts/scent-cast/src/components/arena/arenaTasteTags.ts`

Potential shared hook:

- `artifacts/scent-cast/src/components/arena/useArenaBattle.ts`

Keep `PostCard` stable for the existing community feed. Do not turn the generic feed card into the Arena stage unless the team intentionally wants the feed experience to change everywhere.

## Proposed API Additions

Reuse existing endpoints where possible:

- `GET /api/community/posts/:id` can power an individual battle page now.
- `POST /api/community/posts/:id/votes` can power authenticated voting now.

Potential new endpoints:

- `GET /api/arena/battles/featured`
- `GET /api/arena/battles/:id`
- `GET /api/arena/battles/:id/next`
- `POST /api/arena/battles/:id/votes`
- `POST /api/arena/battles/:id/reasons`

If building fast, avoid duplicating backend behavior until the Arena-specific response shape is actually needed. A frontend mapper over `CommunityPost` is enough for the first visual prototype.

## Battle Page Content Model

A good Arena battle needs this content:

```json
{
  "scenarioTitle": "First Date, 75 Degree Night",
  "scenarioContext": "You want to smell attractive, smooth, and close-contact safe.",
  "left": {
    "name": "Sauvage Elixir",
    "brand": "Dior",
    "descriptor": "Powerful. Sweet. Loud. Compliment-heavy."
  },
  "right": {
    "name": "Bleu de Chanel Parfum",
    "brand": "Chanel",
    "descriptor": "Smooth. Polished. Safer. More intimate."
  },
  "reasonOptions": [
    "More attractive",
    "Safer choice",
    "Better projection",
    "Better for weather",
    "More unique",
    "Better value",
    "I know both"
  ],
  "twist": {
    "headline": "Bleu wins overall, but projection voters backed Sauvage.",
    "source": "Computed from reason breakdown"
  }
}
```

## MVP Acceptance Criteria

Arena MVP should pass these product checks:

- A first-time visitor immediately understands they must pick one of two fragrances.
- The first viewport is one battle, not a filter UI.
- Voting creates an immediate visual change.
- Result reveal is more interesting than a percentage.
- There is one clear `Next Battle` action.
- Comments are absent or secondary in the first experience.
- The page can still deep-link to a specific battle.
- Any segment/twist claim is backed by collected data or clearly editorial.
- The feature still works if there are very few votes.
- Existing `/community` forum behavior is not broken.

## Agent Handoff Checklist

When a future agent starts implementation, inspect these before editing:

1. Confirm current route table in `artifacts/scent-cast/src/App.tsx`.
2. Confirm community DTO fields in `artifacts/scent-cast/src/components/community/communityPosts.ts`.
3. Confirm battle vote UI in `artifacts/scent-cast/src/components/community/PostCard.tsx`.
4. Confirm post creation metadata in `artifacts/scent-cast/src/components/community/PostComposer.tsx`.
5. Confirm backend vote validation in `artifacts/api-server/src/routes/communityPosts.ts`.
6. Confirm schema before adding migrations in `lib/db/src/schema`.
7. Decide whether `/arena` or `/community/battles/:id` is the first route.
8. Decide whether guest votes are local-only or persisted.
9. Do not add fake twist claims that are not backed by stored inputs.
10. Keep the first implementation visually complete but functionally narrow.

## Open Questions

- Should Arena be a top-level navigation item, or live inside Community first?
- Should battle detail URLs be `/arena/:id`, `/arena/battles/:id`, or `/community/battles/:id`?
- Are battles editorially seeded by ScentBeam, user-created, or both?
- Should existing user-created `battle` posts appear in Arena, or should Arena use only curated battles?
- Should anonymous votes count globally, locally only, or only after sign-in?
- What exact anti-abuse rules are acceptable for anonymous voting?
- Should comments exist on Arena battle pages at all in MVP?
- Should battle reasons be required before reveal, optional after vote, or optional after reveal?
- Do attached fragrance snapshots need to become required for Arena battles?
- Should the current community `Battle` composer remain, be hidden, or be replaced by a curated/internal battle creation flow?

## Recommended Next Step

Build a visual-first Arena prototype on top of existing community battle data before changing the database:

1. Add a new route and page shell.
2. Use a hardcoded or mapped featured battle.
3. Reuse existing vote mutation for authenticated users.
4. Implement local reveal state, reason selection, twist copy, and next-battle progression.
5. Only after the visual loop feels right, add structured persistence for reasons, anonymous votes, and twists.

## Two-Agent Research Addendum

This addendum consolidates a follow-up two-agent review performed on 2026-06-11:

- Agent A reviewed frontend routes, community page structure, battle UI, bottle image primitives, and visual/performance constraints.
- Agent B reviewed backend routes, auth/tenant behavior, vote validation, schema, and minimal API/data additions.

The strongest shared conclusion is that Arena should be **additive and purpose-built**, not a restyling of `PostCard` or `/community`. The current community implementation should remain stable while Arena gets its own route, mapper, stage components, and narrow backend additions only after the interaction loop is proven.

### Refined Product Decision

Build `/arena` first.

Reasons:

- It supports the fast viral loop better than a generic post detail page.
- It avoids changing existing `/community` behavior.
- It can use current `GET /api/community/posts?type=battle&limit=...` data immediately.
- It lets the visual and interaction model harden before committing to new database tables.

Defer `/community/battles/:id` until direct battle links are needed. When added, it should reuse the same Arena stage and load a single battle through the existing detail endpoint, rather than introducing a second battle UI.

### Refined First Viewport

The first Arena viewport should be one decisive battle stage:

- Top nav.
- Compact Arena label.
- Scenario title and one-line context.
- Two large fragrance sides facing each other.
- A small central `VS` marker.
- One large vote action per side.
- No feed filters, composer, comments, reaction bar, author profile chrome, or marquee before voting.

After a vote, the same stage should transform in place:

- Winning side and percentage.
- `Your pick` state.
- Optional reason chips.
- One truthful twist block.
- One clear `Next Battle` action.
- Optional share action after the reveal, not before.

This keeps the loop at:

`Scenario -> Pick -> Reveal -> Reason/Twist -> Next`

### Visual Implementation Notes

Reuse these existing primitives:

- `BottleImage` for all bottle rendering. It already handles proxying, fallback states, retries, low-budget video avoidance, and bottom-aligned bottle framing.
- `BrandGoldLabel` for house/brand labels.
- Existing `scent-fragrance-card`, `scent-card-frame`, `scent-card-title`, `scent-primary-button`, and `scent-type-*` styling language where useful.
- Existing dark/gold brand tokens, but avoid making the Arena read like another stacked forum card.

Important `BottleImage` constraint:

- Every Arena side must provide a stable, nonzero image slot, preferably with an explicit `aspect-ratio` and `min-height`. `BottleImage` will not frame correctly if mounted inside a collapsing or content-sized container.

Recommended new components:

- `artifacts/scent-cast/src/pages/arena.tsx`
- `artifacts/scent-cast/src/pages/community-battle.tsx` only when deep links are needed
- `artifacts/scent-cast/src/components/arena/ArenaBattleStage.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaBattleSide.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaReasonPicker.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaResultReveal.tsx`
- `artifacts/scent-cast/src/components/arena/ArenaNextRail.tsx`
- `artifacts/scent-cast/src/components/arena/arenaBattleMapper.ts`
- `artifacts/scent-cast/src/components/arena/arenaTwists.ts`

### Frontend Data Strategy

For the first implementation, do not add a new frontend API client unless needed. Use:

- `useCommunityPosts({ type: 'battle', limit: 6 }, authToken)` for `/arena`.
- `useCommunityPostDetail(postId, enabled, authToken)` later for a deep-linked battle page.
- `useCommunityBattleVote(authToken)` only when the viewer is authenticated.

Add an Arena mapper that converts current `CommunityPost` rows into a stricter local shape:

```ts
interface ArenaBattle {
  id: string;
  title: string;
  scenario: string;
  left: ArenaBattleSide;
  right: ArenaBattleSide;
  votes: Record<string, number>;
  viewerVote: string | null;
}

interface ArenaBattleSide {
  key: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  descriptor: string;
}
```

Mapping rules for current data:

- `metadata.options[0]` maps to `left.key`.
- `metadata.options[1]` maps to `right.key`.
- `fragrances[0]` maps to the left side when present.
- `fragrances[1]` maps to the right side when present.
- If fragrance snapshots are missing, render elegant text-only sides with the existing bottle placeholder, but do not pretend they are catalog-backed fragrances.
- `title` should become the scenario title when present.
- `body` should become the scenario context.

This prevents the Arena UI from repeatedly parsing unknown metadata in render components.

### Guest Voting Rule

MVP guest behavior should be honest and friction-light:

- A guest can tap a side and immediately see a local reveal.
- The app must not add that guest vote to global totals unless it is actually persisted.
- The reveal can show the current server tallies plus a local `Your pick` state.
- Offer sign-in to save the vote, but do not block the first reveal behind auth.

Current blocker:

- `useCommunityBattleVote` calls `requireAuthToken`.
- `POST /api/community/posts/:id/votes` uses `requireAuth`.
- `community_votes.user_id` is non-null.

Therefore, anonymous global voting is not a frontend-only change.

### Backend Refinement

Use the existing backend for the first visual Arena:

- `GET /api/community/posts?type=battle&limit=...`
- `GET /api/community/posts/:id`
- `POST /api/community/posts/:id/votes` for authenticated users

The first backend addition should be reason capture, not a full Arena domain model.

Recommended narrow next endpoint:

- `POST /api/community/posts/:id/vote-reason`

Body:

```json
{
  "choice": "Option A",
  "reason": "more_attractive"
}
```

Validation:

- `:id` must be a UUID.
- Post must exist in tenant.
- Post must be `post_type = 'battle'`.
- `choice` must match one of the two battle options.
- `reason` must be one of the approved reason keys.
- Store one current reason per voter/post for MVP.

Reason keys:

- `more_attractive`
- `safer_choice`
- `better_projection`
- `better_weather_fit`
- `more_unique`
- `better_value`
- `know_both`

Database options, in recommended order:

1. Add nullable `reason` to `community_votes` if authenticated-only reason persistence is enough for the next step.
2. Add a small `arena_vote_reasons` or `community_vote_reasons` table if reason history or separation from vote state matters.
3. Add full `arena_battle_details` / `arena_battle_sides` tables only when curated Arena battles need scheduling, feature ranking, side descriptors, and structured querying.

Do not start with full Arena CRUD.

### Anonymous Persistence Later

If anonymous votes should count globally, add it deliberately:

- Use a signed session or anonymous voter id, preferably through an httpOnly cookie or equivalent trusted session mechanism.
- Avoid raw IP-hash voting as the primary identity model because of privacy and shared-network problems.
- Do not rely on one nullable unique index for mixed auth/anonymous identity.

Recommended future unique-index shape:

- Authenticated: unique `(tenant_id, post_id, user_id)` where `user_id is not null`.
- Anonymous: unique `(tenant_id, post_id, anonymous_voter_id)` where `user_id is null`.

This likely requires changing `community_votes.user_id` nullability or creating an Arena-specific vote table. Do this only when product explicitly wants anonymous votes in global totals.

### Twist Engine Rules

The twist system should be deterministic and truthful.

Allowed first twists:

- Overall winner differs from the strongest reason-specific winner.
- The losing option wins one reason category such as projection, value, safety, or uniqueness.
- Vote total is low, so the twist uses clearly editorial copy instead of claiming crowd insight.

Do not ship claims about:

- owners
- collectors
- gender
- age
- geography
- people like the viewer
- demographic segments
- taste profiles

unless those inputs are collected, stored, and included in the computation.

### Precision Fix To Consider

Current vote validation only rejects an invalid `choice` when metadata resolves to exactly two string options. If malformed legacy battle metadata exists, the vote route does not enforce membership. Before Arena depends on vote integrity, consider hardening `POST /api/community/posts/:id/votes` so battle posts with invalid metadata reject voting instead of accepting arbitrary choices.

### Refined Build Sequence

1. Add lazy `/arena` route and `ArenaPageView` auth wiring in `App.tsx`.
2. Add `pages/arena.tsx` with top nav, SEO/title, and battle query.
3. Add `arenaBattleMapper.ts` and reject unmappable posts at the Arena layer.
4. Build `ArenaBattleStage` with two stable side slots, immediate vote/reveal state, and authenticated save where possible.
5. Add `ArenaReasonPicker` and local deterministic `arenaTwists.ts`.
6. Add `Next Battle` progression through the already-fetched battle list.
7. Add focused unit tests for mapper/twist logic.
8. Add backend reason persistence only after the visual loop feels right.
9. Add anonymous persisted voting only after privacy, anti-abuse, and identity rules are decided.

Verification should be focused. Per the repo instruction, skip extra browser scenario tests that only burn tokens; use targeted type checks/unit tests and one concise visual sanity pass when UI is implemented.

### Updated Bloat Boundary

Do not build these in the first Arena pass:

- leaderboards
- badges
- profile taste graph
- demographic segmentation
- full comments on the first viewport
- post composer inside Arena
- heavy filters
- AI-generated runtime twists
- free-text reason capture
- full Arena admin CRUD
- a second image pipeline
- a marquee or heavy animation before first vote

# Note Pyramid to Main Accord Correlation Handoff

## Context

Branch: `codex/luxury-review-card`

Recent commit already pushed: `86ff069` (`Improve note accord linking`)

The current user-facing feature is the interactive fragrance note pyramid inside ScentCast. When a user clicks a pyramid layer (`top`, `heart`, or `base`), the pyramid overlay shows the notes for that layer and the Main Accords panel highlights the accord bars that correlate to those notes.

The first pass improved this, but the user wants the next pass to be stricter and smarter:

- The clicked pyramid note list must not show a colored matched-note pill treatment.
- If any chip/pill layout is kept for spacing, remove the accord dot, the inline percentage, and the amber/gold matched-note color.
- The Main Accords panel should remain the place where the percent and correlation pulse are shown.
- The matcher needs to become an extensible fragrance taxonomy system, not a thin string matcher.

## Relevant Files

- `artifacts/scent-cast/src/components/NotePyramid.tsx`
  - Renders the clickable pyramid and the layer note overlay.
  - Current matched-note UI is in `MatchedNoteChip`.
  - Current list rendering is in `LayerNotesList`.

- `artifacts/scent-cast/src/components/ScentNotesInfographic.tsx`
  - Renders `AccordPanel` and wires active pyramid notes into the accord chart.
  - Current accord match pulse appears on matching accord bars near the filled percentage endpoint.

- `artifacts/scent-cast/src/lib/noteAccordLinks.ts`
  - Owns note-to-accord matching.
  - Current code includes small hard-coded `NOTE_FAMILY_TERMS` and `ACCORD_FAMILY_TERMS` maps.
  - This should become a better data-driven taxonomy.

- `artifacts/scent-cast/src/lib/noteAccordLinks.test.ts`
  - Existing tests for exact, alias, word-boundary, and basic family matching.

- `artifacts/scent-cast/src/lib/fragranceApi.ts`
  - `normalizedAccordBarPct` preserves raw `pct` values, maps 0-10 scores to percentages, and falls back to rank-based widths.
  - `collectMainAccordDisplayRows` normalizes `derived_metrics.main_accords`.

## Current Behavior After Commit 86ff069

In `NotePyramid.tsx`, `MatchedNoteChip` no longer renders:

- the amber dot
- the inline percentage
- the rounded pill border/background

However, it still renders matched notes in amber/gold text with a pulsing glow:

```tsx
className="inline text-[10px] font-semibold leading-relaxed text-[#ffd98a]"
```

The user clarified that this is still too visually differentiated. The top/heart/base overlay should be text-first and quiet. If matched notes are visually marked at all, keep it very subtle and do not use the gold/amber matched-note color. The correlation should be obvious from the Main Accords panel pulse instead.

In `ScentNotesInfographic.tsx`, matched accord rows currently pulse:

- the accord label text shadow
- the accord bar brightness/glow
- a small endpoint marker at `left: ${fillPct}%`
- the percentage text, now shown with `%`

This is conceptually closer to the desired behavior. Keep the percentage and pulse in the Main Accords panel.

## Required UI Fix

When the user clicks a pyramid layer and sees its notes:

1. Do not show matched notes as colored pills.
2. Do not show a dot inside/near the note label.
3. Do not show a percentage inside/near the note label.
4. Do not color matched note text amber/gold.
5. Render all notes in the layer with a consistent text style.
6. If a matched note needs a hint, use a very quiet treatment only, such as:
   - slightly higher opacity
   - tiny font-weight difference
   - neutral white text shadow
   - no border, no fill, no dot, no percent

The Main Accords chart is where the user should see:

- which accord is connected
- the accord percentage
- the pulsing/highlight state

## Required Matching System Direction

The current matcher is too small and too manual. Build it as an extensible taxonomy that can grow as more fragrances are inspected.

The desired mental model:

1. A fragrance has Main Accords, such as `floral`, `fruity`, `musky`, `fresh`, `woody`, `amber`, `sweet`, `powdery`, etc.
2. A pyramid layer has notes, such as `Peony`, `Lily of the Valley`, `Musk`, `Pear`, `Mandarin Orange`, `Sandalwood`, etc.
3. The system should infer obvious category relationships between those notes and accords.
4. If a note already has a stronger direct allocation, that should reduce ambiguity for the remaining accords.
5. The system should become stronger over time by adding known notes, aliases, families, and tests.

Examples that must work:

- `Musk` -> `Musky`
- `White Musk` -> `Musky`
- `Peony` -> `Floral`
- `Lily of the Valley` -> `Floral`
- `Rose` -> `Rose` if `Rose` is an accord, otherwise `Floral`
- `Pear` -> `Fruity`
- `Peach` -> `Fruity`
- `Mandarin Orange` -> `Citrus` and possibly `Fruity` if no better citrus accord is present
- `Bergamot` -> `Citrus`, `Fresh`
- `Sandalwood` -> `Woody`; possibly `Musky` as a lower-confidence secondary match when no `Woody` accord exists
- `Cedarwood` / `Cedar` -> `Woody`
- `Amber` -> `Amber` / `Ambery`
- `Vanilla` -> `Vanilla`, `Sweet`, `Gourmand`

Important guardrails:

- Do not let `Rosewood` match the accord `Rose`.
- Do not let broad families override exact matches.
- Do not make every fresh fruit note light up every broad accord if a better accord exists.
- Keep matching deterministic and testable.

## Suggested Implementation Approach

Create a more explicit taxonomy module instead of expanding the existing inline maps forever.

Possible structure:

- `artifacts/scent-cast/src/lib/noteAccordTaxonomy.ts`
  - export note aliases
  - export accord aliases
  - export note family memberships
  - export family-to-accord labels
  - export confidence weights

Then keep `noteAccordLinks.ts` focused on scoring and selection.

Suggested scoring order:

1. Exact accord label match
   - `musk` vs `musk`
   - highest confidence

2. Alias / parenthetical match
   - `Agarwood (Oud)` -> `Oud`

3. Word-boundary phrase match
   - `Dark Patchouli` -> `Patchouli`

4. Family match, high confidence
   - `Peony` -> `Floral`
   - `Pear` -> `Fruity`
   - `Musk` -> `Musky`

5. Family match, secondary confidence
   - `Sandalwood` -> `Musky` only if `Woody` is absent and `Musky` exists
   - `Bergamot` -> `Fresh` only if `Citrus` is absent and `Fresh` exists

6. Tie-breakers
   - stronger score wins
   - if scores tie, prefer the accord with higher displayed percentage
   - if still tied, prefer the first visible accord row

The taxonomy should allow one note to have multiple possible families with weights:

```ts
{
  sandalwood: [
    { family: "woody", weight: 1.0 },
    { family: "musky", weight: 0.45 },
    { family: "creamy", weight: 0.35 }
  ],
  bergamot: [
    { family: "citrus", weight: 1.0 },
    { family: "fresh", weight: 0.55 }
  ]
}
```

Then accord labels can map to families:

```ts
{
  floral: ["floral", "white floral", "yellow floral", "rose", "violet"],
  fruity: ["fruity", "fruit", "tropical", "red fruits"],
  musky: ["musk", "musky", "clean musk"],
  woody: ["woody", "woods", "woodiness", "cedar", "sandalwood", "oud"]
}
```

## Suggested Initial Taxonomy Coverage

Start with the most common note families:

- Floral
  - rose, peony, jasmine, lily, lily of the valley, iris, violet, tuberose, orange blossom, neroli, ylang-ylang, magnolia, gardenia, freesia, lilac, osmanthus, mimosa, geranium, carnation, narcissus, hyacinth, lotus, water lily, heliotrope

- Fruity
  - apple, pear, peach, apricot, plum, blackcurrant, cassis, raspberry, strawberry, blackberry, cherry, fig, melon, pineapple, mango, passionfruit, lychee, coconut

- Citrus
  - bergamot, lemon, lime, grapefruit, mandarin, mandarin orange, orange, bitter orange, blood orange, yuzu, citron, petitgrain

- Musky
  - musk, white musk, clean musk, ambrette, musk mallow, cashmeran

- Woody
  - cedar, cedarwood, sandalwood, guaiac wood, agarwood, oud, rosewood, birch, oak, cashmere wood, akigalawood, iso e super, vetiver, patchouli

- Amber / resinous
  - amber, ambergris, ambroxan, labdanum, benzoin, myrrh, olibanum, frankincense, resin

- Sweet / gourmand
  - vanilla, tonka bean, caramel, praline, chocolate, cacao, coffee, honey, sugar, almond, heliotrope

- Fresh / green / aquatic
  - mint, eucalyptus, tea, green tea, aldehydes, marine notes, sea salt, calone, ozonic notes, grass, galbanum, green leaves, violet leaf, fig leaf, tomato leaf

- Spicy
  - pepper, pink pepper, black pepper, cardamom, cinnamon, clove, nutmeg, saffron, ginger, coriander

- Powdery
  - iris, orris, violet, heliotrope, mimosa, tonka bean

## Miss Dior 2021 Reference Case

Use Miss Dior 2021 as a regression case. The user specifically called out:

- `Peony` and `Lily of the Valley` should correlate to `Floral`.
- Any `Musk` note should correlate to `Musky`.
- Fruit notes should correlate to `Fruity`.
- If a main accord says `fresh`, inspect the unallocated notes and determine which ones are best explained by freshness after stronger matches are assigned.

Also investigate why Miss Dior 2021 appears to show two `100%` main accord rows.

Current likely source of the two-100 behavior:

- `normalizedAccordBarPct` returns raw `row.pct` when provided, clamped to 14-100.
- If the engine sends two rows with `pct: 100`, the UI will show both as `100%`.
- If the engine sends 0-10 scores and two rows have `score: 10`, both become `100%`.
- Rank fallback alone should not create two `100%` rows.

Do not blindly change chart math until the raw payload is inspected. Log or inspect `derived_metrics.main_accords` for Miss Dior 2021 first. Decide whether:

- the engine payload is valid and two top accords are intentionally tied,
- the frontend should display tied leaders as-is,
- or the frontend should normalize relative to row rank/display so only the leading row appears as `100%`.

If changing this, add tests in `fragranceApi.test.ts` around `normalizedAccordBarPct` or a new chart-normalization helper.

## Tests To Add

Add or expand tests in `noteAccordLinks.test.ts`:

- `Peony` -> `Floral`
- `Lily of the Valley` -> `Floral`
- `Musk` -> `Musky`
- `Pear` -> `Fruity`
- `Peach` -> `Fruity`
- `Mandarin Orange` -> `Citrus`
- `Bergamot` prefers `Citrus` over `Fresh` when both exist
- `Bergamot` can match `Fresh` when `Citrus` is absent
- `Sandalwood` prefers `Woody` over `Musky` when both exist
- `Sandalwood` can match `Musky` only if `Woody` is absent
- `Rosewood` does not match `Rose`
- exact matches beat family matches
- higher display percentage breaks ties only after confidence score

Add UI-oriented tests if the project already has a component test pattern. If not, keep the UI change simple and verify manually in the browser.

## Validation Commands

Run:

```powershell
corepack pnpm --filter @workspace/scent-cast test
corepack pnpm --filter @workspace/scent-cast typecheck
```

If doing visual QA:

```powershell
corepack pnpm exec vite --config artifacts/scent-cast/vite.config.ts --host 0.0.0.0 --port <free-port>
```

Then load the app, open Miss Dior 2021, click each pyramid layer, and confirm:

- note overlay has no dot
- note overlay has no inline percent
- note overlay has no amber/gold matched-note color
- Main Accords panel pulses the related accord rows
- floral/fruit/musky/woody relationships are visible and sensible
- no unrelated accord row pulses from a broad false positive

## Worktree Safety

At the time this handoff was written, there were unrelated backend/db changes in the working tree. Do not stage or revert them unless the user explicitly asks.

Only touch the scent-cast note/accord files unless the implementation truly requires a shared utility.

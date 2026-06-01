# Thread Background Visual Handoff

## Current User Feedback

The user is unhappy with the current thread background treatment. The specific complaint is that the blur/glow now looks worse, artificial, and visibly over-engineered. The user asked to stop iterating blindly and write this report for the next agent.

The current visual direction should be considered failed. Do not keep tuning the existing values as if this is only a strength/opacity problem.

## Follow-Up Resolution

This handoff was addressed by replacing the thread visual stack with a simpler production treatment:

- one soft aura pseudo-element plus one core pseudo-element
- no repeating grain layer
- no separate halo/glint gradient stack
- smaller perpendicular blur insets for horizontal and vertical threads
- lower-contrast shared core gradients and calmer diagnostic shadow layers

The historical diagnosis below is kept because it explains why the previous blur/glow direction failed and what should be avoided in future passes.

## Relevant Files

- `artifacts/scent-cast/src/components/threads/threadLines.ts`
- `artifacts/scent-cast/src/components/threads/ThreadBackground.tsx`
- `artifacts/scent-cast/src/components/threads/ThreadBackground.css`
- `artifacts/scent-cast/src/pages/ipad-freeze-lab.tsx`

## What Was Recently Changed

The thread data layer was refactored so thread dimensions, gradient stops, and shadow layers are structured instead of stored as CSS strings. That part is technically useful and should probably stay.

The production DOM renderer now renders moving absolutely positioned `.scent-thread-line` nodes. CSS builds the visual material using:

- `background: var(--thread-core)` on the base element
- `::before` as a large blurred haze
- `::after` as a halo/glint/grain overlay
- tone classes such as `--tone-gold`, `--tone-shadow`, `--tone-champagne`
- depth classes controlling haze blur and opacity

The latest attempted visual fix removed `box-shadow` from the base thread and replaced it with blurred pseudo-elements. This did not solve the look.

## Why It Looks Bad

The current CSS is stacking too many visual concepts on very small moving elements:

- The base thread already has a high-contrast multistop gradient.
- `::before` repeats that core gradient and adds a second halo, then blurs the whole oversized region.
- `::after` adds glint, grain, and another halo, then blurs again.
- Tone classes add more gradients with different color ramps.
- Depth classes alter opacity and blur, but the layers still read as separate bands rather than one seamless filament.

The result is not a soft luxury thread. It reads like a thin hard line with cloudy blocks attached to it. The blur is spatially large, but not visually integrated.

The repeating grain is especially suspect. On 1px-3px tall elements, repeating gradients become visual noise and can make the threads look cheap or broken. The next pass should remove grain entirely unless a screenshot proves it helps.

The current palette also risks muddying the composition. Gold, amber, champagne, smoke, and shadow are all active at once, but there is no clear hierarchy. Too many threads have their own glow personality, so the field becomes busy instead of elegant.

## Important Technical Context

The diagnostic canvas renderer in `ipad-freeze-lab.tsx` uses `thread.coreStops` and `thread.shadowLayers` directly. Do not reintroduce per-frame CSS parsing.

The structured data in `threadLines.ts` is a good foundation:

- `width` and `height` are numbers.
- `coreStops` are typed color stops.
- `shadowLayers` are typed shadow layers.
- `tone`, `depth`, `presence`, `stillLanePercent`, and `stillPositionPercent` are explicit.

The production CSS no longer uses `shadowLayers`. If the next agent keeps structured shadow data, either use it meaningfully at the style boundary or remove dead export/function usage after confirming diagnostics still need it.

## Recommended Direction

The next agent should not polish the current layered pseudo-element design. Rebuild the visual treatment around a simpler model:

1. Use one visible core line and one soft aura, not core plus haze plus halo plus glint plus grain.
2. Remove the repeating grain layer.
3. Use lower contrast core gradients. The center highlight should be subtle, not a bright stripe.
4. Make the blur falloff perpendicular to the thread, not a huge rectangular smear along the full thread length.
5. Reduce thread count or presence if the composition feels noisy. The field should breathe.
6. Make far threads almost atmospheric and near threads only slightly brighter.
7. Validate visually in browser screenshots, not by reading CSS.

## Concrete CSS Strategy To Try

Replace the current `.scent-thread-line` pseudo-element stack with something closer to:

- Base element:
  - transparent background or very low opacity `var(--thread-core)`
  - no `box-shadow`
  - no grain
- `::before`:
  - same size as the thread plus small perpendicular expansion
  - `background: var(--thread-core)`
  - `filter: blur(4px)` for near, `blur(7px)` for mid/far
  - opacity around `0.18` to `0.35`
- `::after`:
  - exact or nearly exact thread size
  - `background: var(--thread-core)`
  - opacity around `0.35` to `0.65`
  - no blur or only `blur(0.4px)`

For horizontal threads, expand vertically much more than horizontally. For vertical threads, expand horizontally much more than vertically. Avoid giant along-axis insets like `-74px`; they create rectangular haze that follows the element instead of feeling like optical bloom.

## Concrete Data Strategy To Try

Simplify `THREAD_CORE_STOPS` in `threadLines.ts`.

Most tones should have only 4-5 stops:

- transparent at `0`
- low alpha body around `0.25`
- moderate center around `0.5`
- low alpha body around `0.75`
- transparent at `1`

Avoid very bright center values like `rgba(255, 255, 252, 0.86)` unless there are only a handful of spark threads. The current center highlights are too punchy for dozens of moving lines.

Consider making `shadow` and `smoke` almost invisible. The visual goal should be a dark field with occasional elegant filaments, not equal-weight moving lines everywhere.

## Verification Instructions

Do not judge this by code review alone.

Run the app and inspect:

- production background page using `ThreadBackground`
- `/debug/ipad-freeze?mode=production`
- `/debug/ipad-freeze?mode=dom`
- `/debug/ipad-freeze?mode=canvas`

Use Playwright screenshots at desktop and mobile widths. Compare before/after screenshots side by side. The acceptance bar is:

- no obvious rectangular haze
- no chunky glow bands
- no noisy dashed/grain texture
- threads should feel soft at the edges
- motion should remain smooth
- diagnostics should still show frame counts

Run:

- `npm run typecheck`
- `npm run build`

## Current Git/Branch Context

The branch is `codex/ipad-freeze-instrumentation`.

Recent commits on this branch:

- `31f6724` - `Refactor thread rendering data`
- `366c6bd` - `Smooth thread blur treatment`

The second commit is the one the user says made the visual worse. The next agent may need to revert or replace that visual part, but should preserve the structured data work unless there is a strong reason not to.

## Suggested First Move For Next Agent

Start by removing most of `ThreadBackground.css` visual layering:

- delete `--thread-grain`
- remove the large `--thread-haze-inset`
- make `::before` a small perpendicular blur only
- make `::after` the crisp thread core
- reduce all tone highlight alpha values

Then screenshot before making further changes. The goal is not more glow. The goal is less visible machinery.

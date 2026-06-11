# ScentBeam UI/UX Hardening Handoff

Date: 2026-06-11

Source issue list: `C:\Users\urban\.codex\attachments\d5c8aa16-ce75-4eef-9c5f-0eb3eb97804a\pasted-text.txt`

Active app root inspected: `huge_monorepo/artifacts/scent-cast`

Goal: verify the remaining claimed UX issues against the current codebase, then implement focused hardening so navigation, search, vault, guest mode, community, and accessibility behavior is reliable across desktop, mobile, and tablet. This is a source-level research handoff only; no browser scenario testing was performed.

Update 2026-06-11: the two fragrance-search/image issues tracked in `fragrance_search_and_image_issues.md` are complete. The detail fetch path is now more resilient to transient empty/malformed engine responses, and guest image backfill/persistence no longer leaves newly added imageless fragrances stuck without feedback.

## Executive Summary

Several reported issues appear partially or fully addressed in current source. Do not blindly re-implement those. The strongest confirmed source-level issue is the hero search default selection: search results are programmatically pre-selected, so `Add to Vault` can act on the first result without an explicit user click. The strongest product-hardening gaps are persistent guest-state feedback, delete in-flight feedback, explicit clear control for vault search, and a systematic contrast/focus pass.

The community `Home` and `Start` reports do not map to missing React handlers in current source. `Home` is a `Link to="/"`, and `Start` calls `setComposerOpen(true)`. If these are still broken in production, investigate production bundle freshness, route transition overlays, hit testing, and z-index/pointer-event interaction before changing targets.

## Relevant Files

| Area | Files |
| --- | --- |
| App routes and global modals | `artifacts/scent-cast/src/main.tsx`, `artifacts/scent-cast/src/App.tsx` |
| Global nav | `artifacts/scent-cast/src/components/AppTopNav.tsx` |
| Hero/add-to-vault search | `artifacts/scent-cast/src/components/FragranceCapture.tsx` |
| Vault grid/detail/search | `artifacts/scent-cast/src/components/Wardrobe.tsx`, `artifacts/scent-cast/src/lib/wardrobeSearchSuggest.ts` |
| Wardrobe state and persistence | `artifacts/scent-cast/src/context/WardrobeContext.tsx` |
| Auth and guest mode | `artifacts/scent-cast/src/components/AuthModal.tsx`, `artifacts/scent-cast/src/components/GuestSaveBanner.tsx` |
| Community page | `artifacts/scent-cast/src/pages/community.tsx` |
| Community composer/feed/filters/reactions | `artifacts/scent-cast/src/components/community/PostComposer.tsx`, `PostFilters.tsx`, `CommunityFeed.tsx`, `ReactionBar.tsx`, `communityPosts.ts` |
| Styling and shared accessibility primitives | `artifacts/scent-cast/src/index.css` |
| SPA deployment routing | `artifacts/scent-cast/vercel.json`, root `middleware.js` |

## Claim-by-Claim Status

| Issue claim | Source-level status | Notes |
| --- | --- | --- |
| Community `Home` link does not navigate | Needs production verification | Current nav renders `<Link to="/">Home</Link>` when not on home. Routes include `/` and Vercel rewrites all SPA paths to `index.html`. |
| Community `Start` button unresponsive | Needs production/hit-test verification | Current closed composer button has `onClick={() => setComposerOpen(true)}`. Feed empty/end CTAs call `composerRef.current?.open(...)`. |
| Search overlay requires two Enter presses | Likely already addressed | Hero search is a `<form onSubmit={handleSearch}>`. Community attach search also handles Enter directly. |
| First search result auto-selected | Confirmed | `FragranceCapture` sets `selectedId` to the first result after search and also falls back to first visible result when filters change. |
| Oversized search cards | Likely already improved, still worth visual review | Current hero result cards are `min-h-[60px]` mobile and `sm:min-h-[70px]`, with a scroll region capped at `min(54dvh,28rem)`. |
| No auto-focus on hero search | Partially addressed | Desktop pointer devices auto-focus on mount. Touch devices intentionally do not, to avoid keyboard/viewport jumps. |
| Vault Add Fragrance card only scrolls | Partially addressed, not a true overlay open | It focuses and scrolls to a search input via `handleExpandArchive`, but there is no dedicated command to open the result surface. |
| Vault suggestions show `Unknown Family` | Data/display hardening needed | No literal `Unknown Family` fallback found. The dropdown renders `sug.item.family` if present, so the bad value likely comes from persisted data/API payloads. |
| Delete confirm button lacks feedback | Confirmed product gap | Detail modal closes immediately after calling `onDelete`. Context later toasts success/failure, but button itself has no pending state. |
| Vault search lacks clear-search X | Confirmed | Native WebKit clear affordance is explicitly suppressed and no custom clear button is rendered in the vault search input. |
| `Continue as guest` contrast | Mostly improved, verify contrast | Current button is white border plus translucent white fill on black. Still should be checked against WCAG AA and focus visibility. |
| Guest entry notification disappears quickly | Confirmed product gap | Auth modal emits a toast. Guest banner appears only after 3 local items and auto-dismisses after 9 seconds. |
| Community filter chips lack focus/hover | Mostly addressed | `PostFilters` room and tag buttons include hover and `focus-visible` rings. Verify contrast and keyboard order. |
| Guest reaction buttons look static | Partially addressed | Clicking while signed out opens sign-in and stores a pending reaction. There is no inline "Sign in to react" tooltip/status. |
| Misc contrast/focus/errors | Needs audit | There is a global focus-visible rule and many component rings, but contrast and disabled/outline states should be audited in actual UI surfaces. |

## Detailed Findings And Implementation Guidance

### 1. Global Navigation And Community Start

Evidence:

- `main.tsx` uses `BrowserRouter`.
- `App.tsx` routes `/` to `DashboardView` and `/community` to `CommunityPageView`.
- `AppTopNav.tsx` shows `Home` only on non-home routes and renders `Link to="/"`.
- `artifacts/scent-cast/vercel.json` rewrites all paths to `/index.html`, which is correct for SPA client routing.
- `PostComposer.tsx` closed state renders the `Start` button with `onClick={() => { setComposerOpen(true); setStatusMessage(null); }}`.
- `CommunityFeed.tsx` passes empty/end state CTA clicks to `onStartRoom`, and `community.tsx` maps that to `composerRef.current?.open(preset)`.

Recommended senior-dev work:

1. Verify the production build being tested matches this source. If users still see a dead `Home` link, inspect the deployed bundle hash and Vercel project root/output config first.
2. Check whether `PageTransitionOverlay` or route transition state can cover the top nav after route changes. The nav has `z-50`; route overlays or portals with higher z-index could intercept clicks if pointer events are not disabled after fade.
3. If `Home` failure is real in current build, switch the community `Home` control from `Link` to a small wrapper that calls `navigate('/')` and logs route transition diagnostics in development. Keep `to="/"` semantics if possible.
4. For `Start`, inspect hit testing around the absolute button in the composer header. If a parent pseudo-element or overlay is intercepting clicks, fix pointer events/z-index locally. The React handler exists, so avoid changing the business flow unless runtime evidence points there.
5. Keep guest behavior as designed: guests should be able to open the form; submit should show sign-in requirement. Current `submitPost` opens sign-in only on submit, not on opening the composer.

Focused verification after changes:

- One local check at `/community`: click `Home`, confirm route becomes `/`.
- One local check at `/community`: click top `Start`, confirm composer expands and first input receives focus.
- Keyboard: Tab to `Home` and `Start`, press Enter/Space, confirm behavior.

### 2. Hero Search And Search Result Selection

Evidence:

- `FragranceCapture.tsx` uses a form at the hero search. Enter should submit through `handleSearch`.
- Search work starts immediately: `setUploading(true)`, `setLoadingSurface('search')`, and `setLoadingStatus("Researching Fragrance...")`.
- After results arrive, `setSelectedId(nextMatches.length > 0 ? matchKey(nextMatches[0]) : null)` pre-selects the first result.
- A separate effect also falls back to `setSelectedId(matchKey(visibleMatches[0]))` if no selected row is currently visible.
- Desktop auto-focus exists but is gated to `(hover: hover) and (pointer: fine)`. That is correct for avoiding unwanted mobile keyboard popups.
- Current card sizing is already relatively compact: result cards use `min-h-[60px]` and `sm:min-h-[70px]`.

Confirmed fix: remove default committed selection.

Implementation notes:

1. Keep two concepts separate:
   - `highlightedIndex` or keyboard focus/hover state for visual navigation.
   - `selectedId` for the committed row that `Add to Vault` will act on.
2. After search success, set `selectedId(null)` instead of first result.
3. Remove or narrow the fallback effect that selects the first visible result. It should only clear an invalid selected id, not choose another result automatically.
4. Keep arrow-key behavior accessible if added later, but do not mark an option selected unless the user clicks it or presses Enter/Space on a specific result.
5. Disable the desktop and mobile `Add to Vault` CTA until `selectedId` is non-null. The label already supports `Select a Result`.
6. Update the selected status copy so it does not appear until explicit selection.
7. Add a focused unit/component test if feasible for the state reducer or component behavior: after search results load, no result has `aria-pressed="true"` and CTA is disabled.

Search Enter issue:

- The current hero source should search on first Enter because the input is inside a form with `onSubmit={handleSearch}`.
- If users still need two Enter presses, check runtime focus, IME/composition behavior, and whether a parent intercepts Enter before form submit. Add an `onKeyDown` only if runtime evidence shows form submit is not firing on target browsers.

Oversized cards:

- The current source appears already compact. If visual inspection still shows only 3-4 results, the limiting factor is probably the results panel `max-h-[min(54dvh,28rem)]`, header/filter stack, or overall scroll positioning rather than individual card height.
- Prefer increasing result viewport density by reducing header/filter vertical chrome and allowing a slightly taller scroll region on desktop. Avoid shrinking tap targets below 44px.

Auto-focus:

- Preserve the current no-autofocus-on-touch behavior. For desktop returns from `/community`, confirm `FragranceCapture` remounts and focuses once. If not, add a route-aware focus effect in `DashboardView` keyed by `location.key`, still gated to fine pointer devices.

### 3. Add Fragrance Card And Vault Search

Evidence:

- `Wardrobe.tsx` Add Fragrance card calls `onExpandArchive?.({ target: 'vault' })`.
- `WardrobeContext.tsx` `handleExpandArchive` sets `vaultSearchUiActive(true)`, then searches for either `wardrobe-vault-search` or `scent-add-to-vault-search`, focuses it, and scrolls it into view.
- The empty-vault `Add your first fragrance` control uses the same path.
- No current API exists for `Wardrobe` to directly open the hero search result surface. It can only focus/scroll to search inputs.

Recommended senior-dev work:

1. Decide product behavior:
   - Option A: Add Fragrance focuses the nearest search field and shows a short inline hint. This matches current architecture and is low-risk.
   - Option B: Add Fragrance opens the hero search/result surface directly. This requires lifting an imperative `openSearch(query?)` handle out of `FragranceCapture` or centralizing search overlay state.
2. If implementing Option B, expose a `FragranceCaptureHandle` with a method like `focusSearch({ open: true })` or `startBlankSearch()`. Wire it through `DashboardView`, not `WardrobeContext`, to avoid putting DOM-specific behavior in shared state context.
3. Add a custom clear button to vault search:
   - Render an `X` button inside the search input container when `searchQuery.trim()` is non-empty.
   - On click: clear `searchQuery`, clear suggestions, set focus back to the input, and close the dropdown.
   - Keep the existing WebKit native clear suppression, because the input uses custom right-side icon placement.
4. Revisit the vault search right-side icon if the clear button is added. Use separate slots so Search and X do not overlap on small widths.

### 4. Vault Search Suggestions And `Unknown Family`

Evidence:

- `wardrobeSearchSuggest.ts` uses `item.family` in scoring if present.
- `Wardrobe.tsx` renders suggestion subtext as `[sug.item.family, ...(sug.item.notes ?? []).slice(0, 2)].filter(Boolean).join(' ... ')`.
- There is no literal `Unknown Family` fallback in the current frontend source. If that phrase appears, it is likely stored in item data or returned by an API normalization path.

Recommended senior-dev work:

1. Add a display sanitizer near the UI render path:
   - Treat blank strings, `"Unknown Family"`, `"Unknown"`, `"N/A"`, `"undefined"`, and `"null"` as absent.
   - Do not include absent family in suggestion subtext.
2. Consider applying the same sanitizer in data normalization so bad labels do not leak into filters, detail panels, weather intelligence, or matching.
3. Add a unit test for `buildWardrobeSearchSuggestions` or a small helper to ensure bad family labels are ignored for display. Be careful: removing them from scoring may change search matching if users search "unknown"; that is acceptable.

### 5. Delete Confirmation Feedback

Evidence:

- `Wardrobe.tsx` local state only tracks `deleteConfirming`.
- Confirm click calls `onDelete(selectedItem); closeDetail();` without awaiting deletion.
- `WardrobeContext.tsx` `handleDeleteItem` performs the async DELETE request, then removes item and toasts success. On failure it toasts and reloads wardrobe.
- The modal closes immediately, so users do not see in-button progress or disabled state specific to delete.

Recommended senior-dev work:

1. Make `onDelete` return `Promise<void>` all the way through `WardrobeProps` and await it in `Wardrobe.tsx`.
2. Add local `deleteBusy` state:
   - When confirm is clicked, set `deleteBusy(true)`.
   - Disable both footer buttons while pending or let "Go back" remain disabled to avoid closing during mutation.
   - Render a spinner and label such as `Deleting...`.
3. Close the detail modal only after successful delete. If delete fails, keep the modal open and show `refreshError` or a dedicated delete error line in the footer.
4. Keep context-level toast as secondary feedback. The primary feedback should be immediate and local to the button that was clicked.

### 6. Guest Mode

Evidence:

- `AuthModal.tsx` `Continue as guest` closes modal and fires a toast: `Browsing as guest`.
- `GuestSaveBanner.tsx` appears only when unauthenticated, auth modal is closed, prompt not dismissed, and `items.length >= 3`.
- `GuestSaveBanner` auto-dismisses after 9000ms.
- `AuthModal` guest button has a strong white border and translucent white background, but it should still be contrast-tested against the black modal.

Recommended senior-dev work:

1. Replace the short guest-entry toast with a persistent, dismissible guest banner immediately after `Continue as guest`.
2. Keep a concise message: "Browsing as guest. Your vault is saved on this device only."
3. Do not auto-dismiss the immediate guest banner. Let the user dismiss it.
4. Keep or merge the existing threshold-based save nudge. Avoid showing two guest banners at once.
5. Store dismissal state separately for:
   - "guest mode acknowledged"
   - "save/sign-in nudge dismissed"
6. Verify `Continue as guest` contrast and focus ring:
   - If contrast is marginal, switch to filled high-contrast white or gold button.
   - Ensure focus ring is visible against black and not hidden by border radius/overflow.

### 7. Community Filters And Reactions

Evidence:

- `PostFilters.tsx` room buttons and tag chips include hover and `focus-visible` styles and `aria-pressed`.
- Search in community filters has a custom clear `X`.
- `ReactionBar.tsx` handles signed-out clicks by storing `pendingReaction`, calling `onSignIn()`, and replaying after sign-in.
- There is no inline tooltip or text explaining the signed-out reaction behavior.
- `communityPosts.ts` `useToggleCommunityReaction` requires auth for mutation and restores optimistic state on error.

Recommended senior-dev work:

1. Keep filter semantics, but run a focused keyboard pass:
   - Tab order through room type, community search, tag chips, clear button.
   - Confirm visible focus ring on both active and inactive chips.
   - Confirm selected state is communicated by `aria-pressed`.
2. Add signed-out reaction affordance:
   - On unauthenticated reaction buttons, set `title="Sign in to react"` and `aria-label="Sign in to [label] [targetType]"`.
   - Consider a small tooltip or transient inline status on click before opening auth.
   - Optionally mark them visually as available-but-auth-required, not disabled, because current pending-replay behavior is useful.
3. Consider adding toast/status if reaction mutation fails after sign-in. Current `onError` silently rolls back optimistic cache state.

### 8. Accessibility And Contrast Pass

Evidence:

- Shared color tokens in `index.css` include relatively light text colors on black backgrounds: `#fff7ec`, `#ead8bd`, `#d8c4a8`, `#bfae98`.
- Global focus-visible styling exists for buttons, links, inputs, selects, textareas, and focusable `[tabindex]`.
- Many components also define local focus rings.
- Risk remains in translucent text/borders such as `text-white/40`, `text-white/55`, `border-white/10`, `text-scent-text-subtle` on translucent dark panels, disabled states, and small uppercase labels.

Recommended senior-dev work:

1. Do a token-level contrast audit first:
   - Text on `#030201`, `#020202`, `rgba(0,0,0,0.54)`, `rgba(0,0,0,0.72)`, and gradient panels.
   - Small labels need at least 4.5:1 unless treated as inactive/disabled.
2. Replace ad hoc opacity text with semantic tokens where possible.
3. Keep disabled opacity legible enough when disabled controls still need to communicate why they are unavailable.
4. Verify focus rings are not clipped by overflow-hidden containers, especially:
   - Search result cards.
   - Vault grid cards.
   - Community filter chips.
   - Auth modal buttons.
   - Detail modal footer buttons.
5. Error prevention:
   - Hero search already has descriptive network messages for search/sync failures.
   - Community reaction failures currently roll back silently. Add visible feedback.
   - Delete failure already toasts but should keep local modal feedback if the modal remains open.

## Suggested Implementation Order

1. Fix hero result selection so `Add to Vault` requires explicit selection.
2. Add vault search clear `X`.
3. Add delete pending/error feedback and await delete before closing detail modal.
4. Add immediate persistent guest-mode banner and clean up guest/save nudge state.
5. Add signed-out reaction tooltip/status and mutation failure feedback.
6. Sanitize `Unknown Family` display values.
7. Do focused nav/start production verification and fix hit testing only if reproduced.
8. Run contrast/focus audit and token cleanup.

## Focused Verification Checklist

Keep verification targeted. Avoid broad browser scenario sweeps.

- `pnpm --filter @workspace/scent-cast run typecheck`
- `pnpm --filter @workspace/scent-cast run test`
- Hero search:
  - Enter once starts loading.
  - Results load with no committed selection.
  - `Add to Vault` is disabled until a result is explicitly selected.
  - Selecting a row enables `Add to Vault`.
- Vault:
  - Vault search clear `X` clears text and returns focus.
  - Suggestion subtext does not show `Unknown Family`.
  - Delete confirm shows pending state, disables repeat clicks, and keeps feedback visible on error.
- Guest:
  - `Continue as guest` closes auth modal and shows persistent guest-state banner.
  - Banner can be dismissed.
  - Save/sign-in nudge still appears at the intended threshold without duplicate banners.
- Community:
  - `Home` navigates to `/`.
  - `Start` opens composer for guests and signed-in users.
  - Signed-out reaction click clearly asks user to sign in.
  - Filter chips have visible hover/focus and correct `aria-pressed`.

## Notes On Confidence

This handoff is based on static source inspection of the current `huge_monorepo` app. Claims marked "needs production verification" are not source-proven defects in the inspected code. Treat those as reproduction tasks before implementation.

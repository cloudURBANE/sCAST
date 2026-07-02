# UI/UX Bug-Fix Plan

Verified defects found by a three-way audit (frontend UI/layout, frontend
state/data flow, backend API/services) of the sCAST monorepo. Every item below
was confirmed against the actual code and its callers before being listed —
speculative findings were discarded. The backend audit (oauth, share,
validation, app shell, image-pipeline dedup, notifications routes) found no
verified defects; all six fixes are frontend.

Branch: `claude/bug-fixes-ui-ux-5grchy`

---

## 1. NotificationFeed remounts its entire panel subtree on every render (HIGH)

**File:** `artifacts/scent-cast/src/components/notifications/NotificationFeed.tsx`

**Defect:** `NotificationItem` (line 279), `HeaderActions` (340), `StatusBlock`
(362), `ListBody` (385), and `FeedContent` (441) are declared *inside* the
`NotificationFeed` function body and rendered as JSX component types
(`<FeedContent />` at lines 498/525). Every render creates new function
identities, so React treats them as different component types and
unmounts/remounts the whole subtree. The panel re-renders constantly while
open: the query destructures `isFetching` (line 102) with
`refetchInterval: 15000` (line 119), so `isFetching` flips twice per poll, and
every optimistic mutation patch re-renders too.

**User impact:** With a scrollable list (panel is `h-[28rem]`, list
`overflow-y-auto`), scroll position snaps to the top every 15 seconds and after
every delete / mark-read tap; keyboard focus inside the panel is dropped to
`<body>`.

**Fix plan:** None of the inner components use hooks — they are pure closures
over parent state. Convert them from component types to plain render
functions/JSX values called inline (`renderNotificationItem(item)`,
`renderStatusBlock(...)`, `renderListBody()`, `headerActions`, `feedContent`).
Element identity then comes from the stable underlying DOM/element tree, so no
remount occurs. No visual or behavioral change otherwise.

---

## 2. Vault cards are click-only divs — unreachable by keyboard / assistive tech (MEDIUM)

**Files:**
- `artifacts/scent-cast/src/components/VaultGridTile.tsx` (lines 76–84)
- `artifacts/scent-cast/src/components/SharePage.tsx` (lines 795–802)
- `artifacts/scent-cast/src/components/Wardrobe.tsx` (lines 2142–2147, "Tactical Selection" featured card)

**Defect:** The interactive card wrappers are `motion.div`s with only
`onClick` — no `role`, no `tabIndex`, no key handler. The house pattern for
interactive cards (`BottleMarquee.tsx` lines 223–237) is a real button with
`aria-label`, Enter/Space `onKeyDown`, and a `focus-visible` ring.

**User impact:** Keyboard and screen-reader users can never open the fragrance
detail modal from the Wardrobe grid, the featured card, or a public
`/share/:userId` page (where no alternative path exists at all).

**Fix plan:** Add `role="button"`, `tabIndex={0}`, an `aria-label`
(`"<name> by <brand>"`), an Enter/Space `onKeyDown` that invokes the existing
click handler, and the house focus ring
(`outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45`) to all
three wrappers. Keeping the element a `div` (with button semantics) avoids any
layout/styling regression from native button styles.

---

## 3. SharePage surfaces raw JSON parse errors to visitors (MEDIUM-LOW)

**File:** `artifacts/scent-cast/src/components/SharePage.tsx` (lines 652–657, 704–711)

**Defect:** The share fetch calls `r.json()` without checking `r.ok` or the
content type, and the catch renders `e.message` verbatim in the page headline
and a destructive toast. When the backend/proxy returns an HTML error page
(502/503/504 from the Vercel Edge → Railway hop), visitors of a public shared
vault see `Unexpected token '<', "<!DOCTYPE"... is not valid JSON` as the
error. `ShareModal.tsx` line 74 already implements the correct pattern.

**Fix plan:** Throw a friendly message when `!r.ok`, and wrap the JSON parse so
a non-JSON body maps to the same friendly message. No change to the success
path or the existing `d.error` handling.

---

## 4. Closing the community search panel silently leaves filters applied (LOW)

**File:** `artifacts/scent-cast/src/pages/community.tsx` (lines 159–170 `toggleSearch`, 313–327 panel mount)

**Defect:** `postType` / `postTag` / `postQuery` live in the page but their
only visual representation (`PostFilters`) unmounts when the panel closes.
`toggleSearch` closes the panel without resetting the filters, and the toolbar
shows a neutral "Search" button — the feed stays filtered with no indicator.
The button's own aria-label says "Close search and filters".

**User impact:** Filter the feed, tap Close — the feed looks inexplicably
sparse with no cue and no reset affordance (the empty-state "Clear filters"
only appears at zero results).

**Fix plan:** Clear the three filter states in `toggleSearch`'s closing branch,
matching the control's "Close search and filters" label. Opening the panel
starts from a clean slate, which is consistent with the panel being the only
place filters are visible.

---

## 5. PostComposer room selector misuses listbox/option ARIA (LOW)

**File:** `artifacts/scent-cast/src/components/community/PostComposer.tsx` (lines 907–936)

**Defect:** The room-type button grid has `role="listbox"` with
`role="option"` children carrying *both* `aria-selected` and `aria-pressed`,
and none of the listbox keyboard contract (no roving tabindex / arrow keys).
Screen readers announce a list box whose options double as toggle buttons and
whose arrow keys do nothing. The equivalent widget in `PostFilters.tsx` uses
plain `aria-pressed` buttons — the correct pattern.

**Fix plan:** Replace `role="listbox"` with `role="group"` (keeping
`aria-label="Room type"`), drop `role="option"`/`aria-selected` from the
buttons, keep `aria-pressed`. Pure attribute change; zero visual impact.

---

## 6. AuthContext writes to localStorage unguarded — sign-in can crash the app (MEDIUM)

**File:** `artifacts/scent-cast/src/context/AuthContext.tsx` (lines 63–80 initializer, 178–194 `handleAuth`, 209–212 `handleSignOut`)

**Defect:** The `authToken` state initializer (which runs during the very
first render on an OAuth redirect) and `handleAuth`/`handleSignOut` call
`localStorage.setItem`/`getItem`/`removeItem` bare. Every *other* setter in
the same file wraps storage access in try/catch with the comment "storage
unavailable (private mode / quota) — keep in-memory state only", and
`WardrobeContext`/`WeatherContext` guard all storage access — proving the
codebase expects storage to throw. Where storage access is denied (Safari
private-mode quirks, embedded webviews, blocked-storage browser settings), the
initializer throws during render and the entire app white-screens exactly on
the sign-in redirect.

**Fix plan:** Add tiny `safeStorageGet/Set/Remove` helpers inside
AuthContext and route the unguarded calls through them. In-memory auth state
still works for the session when storage is unavailable, matching the
established degradation pattern in the rest of the file.

---

## Verification plan

- `pnpm run typecheck` (workspace-wide) after all edits.
- `pnpm --filter @workspace/scent-cast run build` to prove the SPA still builds.
- Behavior is preserved everywhere except the six defects; no design tokens,
  fonts, or global styles are touched; no new dependencies.

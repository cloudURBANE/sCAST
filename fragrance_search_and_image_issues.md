# Fragrance Search and Image Resolution Issues

This document compiles the issues reported during the unauthenticated user flow regarding fragrance searching and image resolution. The goal of this document is to provide a senior developer with the exact user experience alongside a high-level technical mapping to the codebase to facilitate root-cause analysis and remediation.

## Completion Status

Completed on 2026-06-11.

* Issue 1 is hardened: `getFragranceDetails` now falls back to the app details API when the fragrance engine returns an empty or malformed successful response, matching the likely transient cold-start/proxy failure shape. The existing add flow also keeps its best-effort local fallback for transient detail failures.
* Issue 2 is resolved for guest users: deferred image saves now show sync state, poll the shared cache without triggering a fresh search, merge found images into the local guest vault, and persist manually selected guest images/framing to local storage.

## Issue 1: Intermittent "Couldn't Find Fragrance" Error on Selection

**Status:** Complete. The detail-fetch path now handles engine transport failures, 5xx responses, and empty/malformed engine bodies by falling back to the app details endpoint before surfacing an error. A unit test covers the empty-body fallback for the Chanel Egoiste Platinum-style selection path.

### User Description (Verbatim)
> "So, there seems to be a issue where basically, uh, I had searched for the fragrance uh on the unsigned in account for uh a Chanel fragrance for it was Egotiste uh Platinum. So, that's E G O I S T E Platinum. Uh and basically, I had got an error. Uh, I cannot re uh, create the error. Uh, but, it basically, it basically had said, that it couldn't uh, it couldn't find the the fragrance. Uh, like like I had already typed in the Chanel, just the brand. And then, it pulled up all of the different results. And so, when I clicked on that one, it had got like this error. And like I said, I couldn't, uh, I I forgot to, you know, put down exactly what it said. Or, you know, copy exactly what the error message said. But, uh, it doesn't look like I can reproduce it. Uh, but I did add an other picture like right after that, or another fragrance right after that, and it worked. And then, I added that same fragrance again, and that one worked."

### Technical Context & Codebase Mapping
The user successfully queried the brand, received a list of candidates, but encountered an error upon selecting "Egotiste Platinum" to add it to the vault. Because the issue was transient and subsequent attempts worked immediately, this points to a network timeout, cold-start latency, or an intermittent scraping failure when fetching the detailed fragrance profile, rather than a deterministic bug.

When a search result is confirmed, the SPA executes a secondary action to fetch the deep intelligence profile before saving it. If this backend request fails or times out, the error is caught and surfaced to the UI.

**Relevant Files:**
* `artifacts/scent-cast/src/components/FragranceCapture.tsx`: Handles the selection and confirmation (`handleConfirm`). This is where the detail fetch is initiated and where `setErrorStatus` catches and displays the error message to the user.
* `artifacts/scent-cast/src/lib/fragranceApi.ts`: Contains the `getFragranceDetails` function which executes the network request to the backend.
* `artifacts/api-server/src/routes/scent.ts`: The `POST /api/scent-profile` route that coordinates the intelligence scraping (`buildProfile`). A timeout or 500 error here propagates back to the SPA.

---

## Issue 2: "No Image Available" Defaulting, Resolved via Manual "Find Image"

**Status:** Complete. Guest saves now schedule a bounded cache-only shared-image poll, display syncing state on imageless tiles/details, and persist successful shared-cache or manual image selections back to the guest vault.

### User Description (Verbatim)
> "Okay, and so for some reason, uh, I just put in two new fragrances, uh, one being Creed Vintage, Tabarome. Uh, and I wasn't, uh, able to get a, uh, it said, "No, image available." Uh, no image, rather. Uh, But, once I clicked on, "Find image," and this is all, using a non-signed in, user account, right? Uh, so I basically clicked on, multiple, bottles line up, and then I clicked "Find image," and I was able to find, the image. Uh, but I'm not sure, why it says "No image." Uh, you know, right now is, uh, the default."

### Technical Context & Codebase Mapping
This behavior perfectly aligns with a known architectural characteristic of the image pipeline (documented internally as "Deferred Image Resolution"). 

By design, when a new fragrance is saved, the backend explicitly defers the image search to prevent blocking the UI. The server returns the profile immediately with `imageResolution: "deferred"`. Since a newly added fragrance has no existing cache hit, it returns an empty `imageUrl`. 
Consequently:
1. The vault saves the item with `imageUrl: ""` and instantly displays the "No image" fallback.
2. The backend asynchronously searches for the image and backfills it into the global catalog.
3. The UI relies on a 60-second polling interval (`batchHydrateImageUrls`) to self-heal the tile.

When the user manually intervened (selecting the "Multiple bottles / lineup" solver and clicking "Find image"), they bypassed the background process and triggered a synchronous Serper-backed refresh, which successfully located and applied the image immediately. The root cause is a UX/timing gap (lack of a loading state for deferred images), not a failure of the image search engine itself.

**Relevant Files:**
* `artifacts/api-server/src/routes/scent.ts`: Orchestrates the save and explicitly calls `buildProfile` with the `{ imageResolution: "deferred" }` flag.
* `artifacts/api-server/src/services/scentEngineCore.ts`: Handles the deferred return logic and fires the background task to backfill the image into the catalog.
* `artifacts/scent-cast/src/components/BottleImage.tsx`: Renders the visual "No image" placeholder when the URL is empty.
* `artifacts/scent-cast/src/components/Wardrobe.tsx`: Houses the manual editor. Triggering `handleRefreshImage` via the dropdown calls `POST /api/refresh-bottle-image` to resolve the image immediately.
* `artifacts/scent-cast/src/components/FragranceCapture.tsx`: Receives the empty `pipelineImageUrl` during the initial add and commits it to the local vault state.

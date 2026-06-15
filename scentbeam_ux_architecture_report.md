# ScentBeam UX and Architecture Enhancement Report
**Date:** June 15, 2026  
**Auditors:** Antigravity Pair-Programming Agent (Frontend UX and Backend & API Subagents)

---

## Executive Summary
This report analyzes the ScentBeam monorepo across the React 19 + Vite frontend (`artifacts/scent-cast/`), the Express 5 API server (`artifacts/api-server/`), and the database models (`lib/db/`). It identifies:
1. **Critical regressions and UX bugs** in mobile navigation, search workflows, and image rendering.
2. **Under-utilized database models** and scaffolded pipelines (Web Push, chat persistence, catalog enrichment).
3. **Architectural bottlenecks** in scent-engine background workers and edge-caching configurations.
4. **Fleshed-out product ideas** to bridge frontend features to backend capabilities.

---

## 1. Frontend UX & Mobile Interaction Hardening

### 1.1 Navigation Bar Idle Hide Regression (Double-Tap Bug)
*   **File Link:** [AppTopNav.tsx:L201-L208](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/AppTopNav.tsx#L201-L208)
*   **Context:** The mobile navigation bar uses an idle scroll timer to hide itself after scroll settling:
    ```typescript
    idleTimerRef.current = window.setTimeout(() => {
      setNavVisible(false);
      idleTimerRef.current = null;
    }, 1500); // 1.5-second idle hide
    ```
*   **Problem:** This violates the design specification documented in [AppTopNav.tsx:L155-L164](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/AppTopNav.tsx#L155-L164). Hiding the bar at rest forces users to tap once to wake the navigation bar, and tap a second time to execute navigation (the "double-tap" bug).
*   **Recommendation:** Remove the `setTimeout` block. The navigation bar should hide *only* during active downward scroll and remain fully visible when scrolling is at rest.

### 1.2 PWA Install Banner Offset Mismatch
*   **File Link:** [InstallPrompt.tsx:L112-L113](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/pwa/InstallPrompt.tsx#L112-L113)
*   **Context:** The PWA install banner is offset on mobile using:
    ```css
    bottom-[calc(var(--bottomnav-h,0px)+0.5rem)]
    ```
*   **Problem:** While `--bottomnav-h` is static, the actual bottom navigation offset is adjusted dynamically in [AppTopNav.tsx:L175-L180](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/AppTopNav.tsx#L175-L180) via `--mobile-nav-offset`. When the bottom nav slides out of view, the PWA banner remains stuck floating above an empty space.
*   **Recommendation:** Align the banner wrapper class to use `bottom-[calc(var(--mobile-nav-offset,var(--bottomnav-h))+0.5rem)]` so the banner and navigation bar slide down in unison.

### 1.3 Fragrance Brand Acronym Search Mapping
*   **File Link:** [fragranceApi.ts:L5-L8](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/lib/fragranceApi.ts#L5-L8)
*   **Context:** The SPA uses a client-side alias map to expand acronyms because the backend Google-backed searches fail on short codes:
    ```typescript
    const SEARCH_QUERY_BRAND_ALIASES: ReadonlyArray<readonly [string, string]> = [
      ["mfk", "Maison Francis Kurkdjian"],
      ["ysl", "Yves Saint Laurent"],
    ];
    ```
*   **Problem:** It is extremely limited and misses common fragrance queries.
*   **Recommendation:** Expand the map to support other standard acronyms:
    *   `["tf", "Tom Ford"]`
    *   `["jpg", "Jean Paul Gaultier"]`
    *   `["pdm", "Parfums de Marly"]`
    *   `["eldo", "Etat Libre d'Orange"]`
    *   `["adp", "Acqua di Parma"]`
    *   `["atg", "Aaron Terence Hughes"]`

### 1.4 Deferred Image Placeholder & Polling Lag
*   **File Link:** [WardrobeContext.tsx:L735](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/context/WardrobeContext.tsx#L735)
*   **Context:** When a fragrance is added to the wardrobe, the API processes image resolution asynchronously in the background (`imageResolution: "deferred"`).
*   **Problem:** The initial response returns `imageUrl = ""`. The card immediately displays a "No Image" fallback. The background worker writes the resolved image to the catalog database, but the client does not pull the updated image until the global 60-second polling interval ticks.
*   **Recommendation:** 
    1. Show a loading skeleton or a status icon ("Resolving bottle artwork...") on the wardrobe card if `imageUrl === ""` and a sync flag is active.
    2. Implement a localized retry-backoff poll (e.g. checks at 5s, 15s, and 30s) to update the individual card's image immediately upon resolution.

### 1.5 Double-Action Sequence on Mobile Search
*   **File Link:** [FragranceCapture.tsx:L1401-L1406](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx#L1401-L1406) and [FragranceCapture.tsx:L1450-L1473](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/FragranceCapture.tsx#L1450-L1473)
*   **Problem:** Selecting a fragrance from search results only sets the `selectedId` state. The user must then scroll down and tap the floating "Add to Vault" bar at the bottom. This feels sluggish on mobile screens.
*   **Recommendation:** Render a prominent "+" action button directly overlaying the selected search result card to complete the addition in one tap, or auto-add on a single tap if there is only a single matching result.

---

## 2. Backend Architecture & Database Optimization

### 2.1 Conversations & Messages Stateless Drift
*   **File Links:** 
    *   [conversations.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/conversations.ts)
    *   [messages.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/messages.ts)
    *   [scentMissionService.ts:L31-33](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/services/scentMissionService.ts#L31-L33)
*   **Problem:** These database tables are defined but completely unused. In `scentMissionService.ts`, it is noted:
    > *"Chat persistence is deliberately deferred — the existing `conversations`/`messages` tables are not tenant/user-scoped, so nothing is written to them"*
*   **Security Hazard:** Neither schema contains a `userId` or `tenantId` field. Implementing them directly without schema modifications will lead to a cross-tenant data leak where one user could inspect another user's conversation threads.
*   **Recommendation:** Alter the tables to include `userId` and `tenantId` foreign keys, and wire the stateless `/api/scent-mission` endpoint to persist sessions in the database instead of passing the full history back and forth over HTTP.

### 2.2 Unwired Enrichment Queue Foundation
*   **File Links:** 
    *   [enrichmentJobs.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/enrichmentJobs.ts)
    *   [enrichmentQueue.ts:L8-11](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/services/enrichmentQueue.ts#L8-L11)
    *   [enrichment.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/routes/enrichment.ts)
*   **Problem:** The monorepo has defined the database schema, retry queues, and endpoints (`/api/enrichment/status`) for background fragrance page scraping. However, it is explicitly commented that no producer enqueues jobs and no active worker consumer runs. The status endpoint simply returns `{ status: "not_found" }`.
*   **Recommendation:** Implement the worker process using a cron service (or a simple Redis/DB-backed interval task runner) to fetch incomplete catalog items. Allow the frontend to enqueue a scraping job when a user encounters a catalog item with partial note data.

### 2.3 Scent Engine Background Race Conditions
*   **File Link:** [scentEngineCore.ts:L378-409](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/services/scentEngineCore.ts#L378-L409)
*   **Problem:** In `buildProfileWithDeps`, if `imageResolution` is set to `"deferred"`, the service spawns an unawaited promise to execute `resolveImageNow()`. If multiple users request or lookup the same brand-new fragrance simultaneously, multiple concurrent unawaited promises will launch to fetch and process images (hitting external Google and background removal APIs), triggering duplicate database writes, high latency, and key rate exhaustion.
*   **Recommendation:** Implement an in-memory lock or reuse the existing in-flight deduplication map from [imagePipeline.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/services/imagePipeline.ts) to guard concurrent fragrance profile generation.

### 2.4 Edge Caching Gap for Image Proxy
*   **File Links:** 
    *   [imageProxy.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/routes/imageProxy.ts)
    *   [middleware.js](file:///c:/Users/urban/my_project_workspace/huge_monorepo/middleware.js)
*   **Problem:** The node proxy route serves, resizes, and caches images in-memory on the Express backend (Railway). However, the Vercel edge `middleware.js` simply proxies all `/api/*` requests straight to the origin server.
*   **Recommendation:** Configure Vercel Edge caching headers (`Cache-Control: public, max-age=31536000, s-maxage=31536000`) for the `/api/images/proxy` route so that subsequent requests for hot-linked bottle images are served instantly from the edge CDN rather than hitting the Express event loop.

---

## 3. Unfleshed-Out Web App Ideas (UX Opportunities)

### 3.1 Fully Realize the Scent Arena Battles
*   **Relevant Docs:** [SCENTBEAM_ARENA_BATTLES_PLAN.md](file:///c:/Users/urban/my_project_workspace/huge_monorepo/docs/SCENTBEAM_ARENA_BATTLES_PLAN.md)
*   **Relevant Code:** [ArenaBattleStage.tsx](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/arena/ArenaBattleStage.tsx), [communityVotes.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/communityVotes.ts)
*   **Current State:** Battles exist in a basic state. The frontend has a skeleton game view, and the database has a `community_votes` table. However, vote switching lacks clear indicators on mobile (no indication that tapping a side changes your vote, see [ArenaBattleSide.tsx:L65-L77](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/arena/ArenaBattleSide.tsx#L65-L77)), and "Skip reasons" preferences are saved to local storage rather than synced to the database ([ArenaBattleStage.tsx:L104-L107](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/arena/ArenaBattleStage.tsx#L104-L107)).
*   **Action Plan:**
    1. **Vote Reason Aggregate Analytics:** Leverage the nullable `reason` field in [communityVotes.ts:L20-23](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/communityVotes.ts#L20-L23) and expose aggregate statistics. Once a user votes, show them a breakdown (e.g. *"75% of voters chose Dior Sauvage because they preferred its projection"*).
    2. **Judgments Feed:** Refactor the `/arena` view into a clean, Tinder-style card stack where users can quickly swipe left/right to judge fragrance matchups.

### 3.2 Threaded Comments and Community Dynamics
*   **Relevant Code:** [CommentThread.tsx:L85-L123](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/community/CommentThread.tsx#L85-L123), [communityPosts.ts:L61](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/scent-cast/src/components/community/communityPosts.ts#L61)
*   **Current State:** The database and front-end interface type definitions support nesting via `parentCommentId: string | null`. However, the React components render comments as a single flat list, with no UI for replying to individual replies or maintaining hierarchies.
*   **Action Plan:** Add a recursion loop to `CommentThread.tsx` to group comments by `parentCommentId`. Render an inline "Reply" button below each comment that reveals an nested text composer, creating authentic thread conversations.

### 3.3 Active AI Beam Agent Loop Exposure
*   **Relevant Docs:** [03-migration-plan.md](file:///c:/Users/urban/my_project_workspace/huge_monorepo/docs/beam-agent/03-migration-plan.md)
*   **Relevant Code:** [beamAgentLoop.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/beam-agent/beamAgentLoop.ts), [app.ts:L55](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/app.ts#L55)
*   **Current State:** The Phase 1 read-only AI agent loop runs backend-only and maintains run states in memory. It is entirely "dark" to the front-end, which still communicates via the old, scripted `/api/scent-mission` route.
*   **Action Plan:** 
    1. **Server-Sent Events (SSE):** Create an SSE route `/api/runs/:id/events` in [app.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/app.ts) to stream the agent's actions, tool calls, and text output.
    2. **Real-time Console Component:** Create a `BeamAgentPanel` component in the frontend to visualize the agent's internal reasoning steps, showing tool logs (e.g. "Scanning local weather...", "Matching wardrobe notes...") in real-time.
    3. **Persistence Layer:** Link `beam-agent` states to the unused `conversations` and `messages` tables (adding the necessary tenant/user foreign keys) so users can resume past chatbot discussions.

### 3.4 Web Push notifications for Scent Recommendations and Actions
*   **Relevant Code:** [pushService.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/artifacts/api-server/src/services/pushService.ts), [pushSubscriptions.ts](file:///c:/Users/urban/my_project_workspace/huge_monorepo/lib/db/src/schema/pushSubscriptions.ts)
*   **Current State:** Web push subscription tables exist and administrative broadcasting is supported, but no features trigger push notifications for end-users automatically.
*   **Action Plan:**
    1. Add a Web Push consent banner in the frontend header.
    2. Implement automatic push notifications when:
        *   A user receives a comment or reaction on a community post.
        *   The weather changes drastically in their zip code (triggering a morning push suggesting the perfect fragrance for the day).
        *   An enrichment scraping job completes.

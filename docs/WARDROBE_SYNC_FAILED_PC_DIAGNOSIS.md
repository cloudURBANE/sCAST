# "Sync failed with wardrobe" on PC — diagnosis + desktop checklist

_Saved 2026-06-02. Updated after live verification._

## CONFIRMED ROOT CAUSE (verified 2026-06-02)

Login does not persist on `scentbeam.com`, so every `/api/wardrobe` call is a 401.

1. Backend is healthy: `GET https://api.scentbeam.com/api/wardrobe` → `401 {"error":"Unauthorized"}`
   (Express `requireAuth`), `x-powered-by: Express`, Railway edge. So this is **not** a
   proxy/BACKEND_ORIGIN outage.
2. The SPA starts login with a relative `window.location.href = '/api/auth/google'`
   (`AuthModal.tsx:30`), same-origin from scentbeam.com.
3. The backend builds Google's `redirect_uri` from `PUBLIC_APP_URL` (`oauth.ts:16,151,180`),
   which was pinned to the **dead** `https://scent-cast-explore.vercel.app`. So Google sends
   the user (and the `oauth_token`) to that old domain; `res.redirect('/?oauth_token=...')`
   then lands the token in localStorage on the **wrong** origin. Back on scentbeam.com the
   user has no `scent_token` → 401 → "sync failed".
4. Secondary bug: the SPA reported that 401 as "Synchronization Error — check your internet
   connection" and never cleared the dead token (`WardrobeContext.tsx`).

### Fixes applied in this repo (still need dashboard deploy — see bottom)
- `ScentCast.env`: `PUBLIC_APP_URL` → `https://scentbeam.com`,
  `BACKEND_ORIGIN` → `https://api.scentbeam.com`, `VITE_API_BASE_URL` → `https://api.scentbeam.com`,
  `CORS_ORIGIN` → `https://scentbeam.com`.
- `WardrobeContext.tsx` `loadWardrobe`: on 401, `handleSignOut()` + reopen auth modal +
  "Session Expired" toast, instead of the generic network error.

### Must be done in the dashboards (committed files do NOT change prod)
- **Railway** (backend service): set `PUBLIC_APP_URL=https://scentbeam.com`.
- **Vercel** (frontend project, Production env): set `BACKEND_ORIGIN=https://api.scentbeam.com`
  (and `VITE_API_BASE_URL=https://api.scentbeam.com` if the SPA should call the API directly).
- **Google Cloud Console** → OAuth client → Authorized redirect URIs must include
  `https://scentbeam.com/api/auth/google/callback` (add `https://www.scentbeam.com/...` too if
  www is used), and Authorized JavaScript origins `https://scentbeam.com`. Without this you get
  `redirect_uri_mismatch`.
- Redeploy both, then existing stale-token users get auto-signed-out and re-prompted by the
  new 401 handling.

---

_Original checklist below (still valid for triage)._

## Most likely root cause: stale/invalid `scent_token` reported as a generic network error

`scent_token` (localStorage) is just `users.token`, an opaque UUID — not a JWT.
The backend looks the user up by that token and returns **401 `{"error":"Invalid token"}`**
when no row matches (`artifacts/api-server/src/middlewares/auth.ts:25-39`).

After the Supabase DB recovery (`docs/OAUTH_DB_RECOVERY_STATUS_2026-05-06.md`, only 4
`users` rows restored), any browser still holding a **pre-reset token** points to a
user row that no longer matches → 401 on every protected call. `AUTH_FLOW_MAP.md`
lists this exact case: "Old browser token points to missing user row in reset DB."

Two reasons it shows up as "sync failed" instead of "please log in again":

1. `loadWardrobe` collapses every non-OK status into one message:
   `WardrobeContext.tsx:493-508` → `throw new Error(\`HTTP ${res.status}\`)` →
   toast **"Synchronization Error — ... Check your internet connection."**
   (same for 401 / 502 / 503). "Settings Sync Failed" toast right below at :544-550.
2. **No 401 recovery anywhere.** `handleSignOut` is only wired to the manual
   sign-out button (`App.tsx:457,684`). Nothing clears a bad token or re-prompts.
   Email/avatar come straight from localStorage (`AuthContext.tsx:45-51`), so the
   user *looks* logged in while every sync silently 401s. PC-specific because that's
   the browser carrying the old token; a freshly-logged-in phone got a valid one.

## Desktop checklist (Chrome → F12)

**Console:**
- `localStorage.getItem('scent_token')`
  - `null` → not logged in on desktop (log in via Google; explains it entirely).
  - a value → likely the stale-token bug above; confirm with Network step.

**Network (reload the failing page):**
- `GET /api/wardrobe`:
  - **401** → stale/invalid token (this bug). Fix: sign out + sign back in, or in
    Console run `localStorage.removeItem('scent_token')` then reload and log in.
  - **502/503** → backend/proxy config: `BACKEND_ORIGIN` unset on Vercel = 503
    (`middleware.js:62-70`); Railway unreachable = 502.
  - **200 with `[]`** → empty wardrobe but healthy; not this bug.

**Network (click Add on a fragrance):**
- `POST /api/engine/fragrances/details` (external Python engine,
  `srt-scent-engine-production…`):
  - marked **blocked / ERR_BLOCKED_BY_CLIENT** → an ad/privacy extension is killing
    the external search engine. Retry in Incognito (extensions off); if it works
    there, it's an extension. This is a *separate* failure from the wardrobe 401 —
    it breaks search/Add ("Vault sync failed", `FragranceCapture.tsx:459`), not the
    wardrobe load.

## Suggested code fix (when back at desktop)

In `loadWardrobe` (and the share-settings fetch) treat 401 specially: clear the
token via `handleSignOut()` and open the auth modal, instead of showing the generic
"check your internet connection" toast. That turns a permanent silent-failure state
into a "please sign in again" prompt and lets users self-recover from stale tokens.

# Environment Map

Secret values are intentionally omitted. This table lists names, purpose, and failure modes only.

| Variable | Used In | Frontend/Backend | Expected Shape | Safe For Frontend? | Required For Login? | Failure If Wrong |
|---|---|---|---|---|---|---|
| `NODE_ENV` | Build/runtime configs | Both | `development` or `production` | Yes if non-secret | No | Wrong build/runtime behavior. |
| `PORT` | API `index.ts`, Vite preview/dev, Docker/Railway | Backend/local frontend server | Positive integer | No need | API yes on Railway | Server fails to start if missing/invalid for API. |
| `DATABASE_URL` | `lib/db/src/index.ts`, Drizzle config | Backend | Postgres connection URL, likely Supabase pooler/direct URL | No | Yes | API startup fails or points to wrong/reset DB. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `lib/db/src/index.ts` | Backend | `true` or `false` | No | Indirect | TLS/cert failures or overly strict connection behavior. |
| `BASE_PATH` | `artifacts/scent-cast/vite.config.ts` | Frontend build | URL path prefix, usually `/` | Yes | No | Static asset paths break. |
| `BACKEND_ORIGIN` | `middleware.js`, `artifacts/scent-cast/middleware.js` | Vercel frontend middleware | Absolute URL, no trailing slash | No secret, but server-only | Yes for hosted frontend | `/api/*` proxy returns 503/502 or hits wrong backend. |
| `GOOGLE_CLIENT_ID` | `routes/oauth.ts` | Backend | Google OAuth client ID | No | Yes for Google login | `/api/auth/google` returns 503 or callback fails. |
| `GOOGLE_CLIENT_SECRET` | `routes/oauth.ts` | Backend | Google OAuth client secret | No | Yes for Google login | Token exchange fails. |
| `OAUTH_PUBLIC_URL` | `routes/oauth.ts` | Backend | Canonical public base URL | No secret | Yes in proxy/tunnel deployments | Google callback URI mismatch. |
| `PUBLIC_APP_URL` | `routes/oauth.ts` | Backend | Public app URL | No secret | Indirect | Wrong OAuth base if `OAUTH_PUBLIC_URL` unset. |
| `FRONTEND_URL` | `routes/oauth.ts`, listed in local env | Backend | Public frontend URL | No secret | Indirect | Wrong OAuth base if higher priority unset. |
| `REPLIT_DOMAINS` | `routes/oauth.ts` fallback | Backend | Comma-separated Replit domains | No | No for Vercel/Railway | Wrong callback if stale Replit value wins fallback. |
| `REPLIT_DEV_DOMAIN` | `routes/oauth.ts` fallback | Backend | Replit dev host | No | No for Vercel/Railway | Wrong callback if stale. |
| `DEFAULT_WEATHER_LAT` | `weatherService.ts` | Backend | Latitude float | No secret | No | `/api/weather` uses the built-in Chicago fallback when browser geolocation is unavailable. |
| `DEFAULT_WEATHER_LON` | `weatherService.ts` | Backend | Longitude float | No secret | No | `/api/weather` uses the built-in Chicago fallback when browser geolocation is unavailable. |
| `DEFAULT_WEATHER_LOCATION` | `weatherService.ts` | Backend | Human-readable location label | No secret | No | Simulated fallback labels the weather as Chicago. |
| `SERPER_API_KEY` | `serperService.ts` | Backend | Serper API key | No | No | Image search disabled; fragrance image refresh weaker. |
| `SERPER_IMAGE_API_URL` | `serperService.ts` | Backend | URL, defaults to Serper images endpoint | No | No | Image search hits wrong endpoint. |
| `REMOVE_BG_API_KEY` | `bgService.ts` | Backend | Poof/remove-bg API key | No | No | Falls back to local trimming/normalization only. |
| `FIREBASE_PROJECT_ID` | `firebaseCache.ts` | Backend | Firebase project ID | No secret, but backend-only | No | Firestore cache disabled if missing/wrong. |
| `FIREBASE_CLIENT_EMAIL` | `firebaseCache.ts` | Backend | Firebase service account email | No | No | Firestore auth fails. |
| `FIREBASE_PRIVATE_KEY` | `firebaseCache.ts` | Backend | PEM with escaped `\n` when single-line | No | No | Firestore init fails. |
| `LOG_LEVEL` | `logger.ts` | Backend | Pino log level | No | No | Too noisy/quiet logs. |
| `CORS_ORIGIN` | Present in `ScentCast.env` | Backend | Origin URL/list | No | No | Not used by current inspected code because `cors()` is open. |
| `GOOGLE_API_KEY` | Present in `ScentCast.env` | Unknown/current unused | Google API key | No | No | No current runtime usage found. |
| `GOOGLE_CSE_ID` | Present in `ScentCast.env` | Unknown/current unused | Google custom search ID | No | No | No current runtime usage found. |
| `SESSION_SECRET` | Present in `ScentCast.env` | Unknown/current unused | Random secret string | No | No | No current runtime usage found. |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | Gemini integration libs | Backend library | API key | No | No | Only matters if Gemini libs are imported. |
| `AI_INTEGRATIONS_GEMINI_BASE_URL` | Gemini integration libs | Backend library | URL | No | No | Only matters if Gemini libs are imported. |
| `REPL_ID` | Vite config optional Replit plugins | Frontend build/dev | Replit ID | No | No | Replit plugin activation only. |
| `API_BASE_URL` | `scripts/src/rebuild-user-wardrobe.ts` | Script | API base URL | No secret | No | Script calls wrong API. |
| `ADMIN_SECRET` | `middlewares/adminSecret.ts`, `routes/admin.ts`, `scripts/src/rebuild-user-wardrobe.ts` | Backend + script | Shared secret string | No | Yes for `rebuild-user` script | 401 on admin rebuild; script exits at startup if unset. |

## Env Source Priority

Local API startup imports `env-bootstrap.ts`, which loads repo-root `.env` first and then `ScentCast.env` with override when present.

Production:

- Railway must have backend variables, especially `DATABASE_URL`, OAuth, image/Firebase keys.
- Vercel must have frontend middleware variable `BACKEND_ORIGIN`.
- Vite exposes only `VITE_*` variables to browser bundles; none are required for current same-origin API calls.

## 1:1 Restore Env Invariant

After staging restore validates, Railway `DATABASE_URL` must point to the restored database that contains the old `public.users` rows and tokens. If Railway points to a reset/new DB, frontend code reverts will not restore login continuity.


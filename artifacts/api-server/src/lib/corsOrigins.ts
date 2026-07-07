/**
 * Parse the CORS_ALLOWED_ORIGINS env value (comma-separated exact origins)
 * into the value expected by the `cors` middleware's `origin` option.
 *
 * Empty/unset → `false`: no CORS headers are emitted at all. Same-origin
 * requests (the production SPA behind CloudFront) never send a preflight, so
 * they are unaffected; only third-party websites lose browser access to the
 * cost-bearing endpoints.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] | false {
  const origins = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : false;
}

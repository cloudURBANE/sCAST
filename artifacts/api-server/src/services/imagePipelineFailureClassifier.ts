// Pure decision helper for the image pipeline's negative cache.
//
// Kept dependency-free (no imports) so it can be unit-tested in isolation by the
// node:test runner, which does not bundle and cannot follow the extensionless
// relative imports used throughout imagePipeline.ts.
//
// Problem it solves (image-pipeline audit, finding #4): processCandidate used to
// persist a "failed" image_cache row for EVERY error. Because that negative
// cache is keyed only on the source URL hash, a single transient failure (a Poof
// blip, an upstream 5xx, a network timeout, a storage/DB hiccup) blacked out the
// source for every caller — every user, every lookup key — for the full retry
// window (6h by default). Only deterministic, source/content-level failures are
// worth caching: those will keep failing, so suppressing retries protects
// Serper/Poof/Sharp. Everything else must be allowed to retry on the next
// request.
//
// Bias: when the cause is ambiguous we return false (do NOT negative-cache) so
// the next request retries. A wrong "terminal" verdict hides a valid image for
// hours (user-visible breakage); a wrong "transient" verdict only costs one
// extra reprocess attempt.

/** Error-code style markers for transient network / socket failures. */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Lowercased message fragments that indicate a deterministic, cacheable failure. */
const TERMINAL_MESSAGE_FRAGMENTS = [
  // Our own deterministic content guards.
  "invalid data image",
  "optimized image metadata missing dimensions",
  // Sharp decode failures on genuinely unusable bytes.
  "unsupported image format",
  "input buffer contains unsupported image format",
  "input file contains unsupported image format",
  "input buffer has corrupt header",
  "vipsforeignload",
];

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Returns true only when an image-pipeline candidate failure is deterministic
 * enough to persist as a negative-cache ("failed") row. Transient and ambiguous
 * failures return false so the pipeline retries on the next request.
 */
export function shouldNegativeCacheImageFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; transient?: unknown };

  // Explicit transient signals always win — never cache these.
  if (e.transient === true) return false;
  const code = readString(e.code).toUpperCase();
  if (code && TRANSIENT_ERROR_CODES.has(code)) return false;

  const name = readString(e.name);
  const message = readString(e.message).toLowerCase();

  // A safe-fetch rejection carries an authoritative `transient` flag (checked
  // above), so any UnsafeImageUrlError reaching here is a deterministic URL or
  // content problem (bad scheme, private host, 4xx, unsupported type, markup
  // payload, oversize, too many redirects) — worth caching. Decide it before the
  // generic message heuristics below, whose "fetch failed" fragment would
  // otherwise collide with our own "Image fetch failed with HTTP 4xx" message.
  if (name === "UnsafeImageUrlError") return true;

  // Abort / timeout from fetch or our timeout signal: transient.
  if (name === "AbortError" || name === "TimeoutError") return false;
  if (message.includes("aborted") || message.includes("timeout") || message.includes("timed out")) {
    return false;
  }
  if (message.includes("fetch failed") || message.includes("socket hang up") || message.includes("network")) {
    return false;
  }

  // Recognized deterministic content/decode failures.
  if (TERMINAL_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) return true;

  // Unknown cause (e.g. a generic "Image processing failed" from a swallowed
  // upstream download error, or a storage/DB error): bias toward retry.
  return false;
}

/**
 * Compatibility shim — the scent weather engine now lives in the shared
 * workspace package so the API server's mission agent can run the exact same
 * scoring. Existing `@/lib/scentWeatherEngine` imports keep working through
 * this re-export; new code should import `@workspace/scent-weather-engine`
 * directly.
 */
export * from "@workspace/scent-weather-engine";

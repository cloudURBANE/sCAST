/**
 * Compatibility shim — the weekly outlook planner now lives in the shared
 * workspace package so the API server's mission ranker derives candidates and
 * scores them with the exact same math as the home hero and the forecast
 * (A6-GAP2). Existing `@/lib/weeklyOutlookPlanner` imports keep working through
 * this re-export; new code should import `@workspace/scent-weather-engine`.
 */
export * from "@workspace/scent-weather-engine";

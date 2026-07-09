import { z } from "zod";

/**
 * Boot-time env validation (production-readiness G2). Three tiers:
 *
 * - REQUIRED: boot fails with one clear message when missing/invalid.
 * - INTEGRATIONS: optional keys; presence is summarized in one structured boot
 *   line so "which integrations are on in this deploy" is greppable.
 * - SHAPE-CHECKED: flags and numbers whose *format* is validated so a typo'd
 *   value (ENRICHMENT_WORKER_ENABLED=ture, OAUTH_RATE_LIMIT=10s) warns loudly
 *   at boot instead of silently meaning "off"/"default".
 *
 * Validation is the value; typed getters migrate incrementally — call sites
 * keep reading process.env until touched for other reasons.
 *
 * IMPORTANT: flag validators mirror how each call site actually parses the
 * var. Vars parsed with `=== "true"` use the strict enum; vars parsed with
 * /^(1|true|yes|on)$/i (envFlagEnabled, enrichmentQueue) accept that set.
 */

const strictBool = z.enum(["true", "false"]);
const looseBool = z.string().regex(/^(1|0|true|false|yes|no|on|off)$/i, "not a recognized boolean");
const intString = z.string().regex(/^\d+$/, "not an integer");
const numberString = z.string().regex(/^\d+(\.\d+)?$/, "not a number");
const urlString = z.string().url();

type Tier = "required" | "integration" | "shape";

type EnvSpec = {
  schema: z.ZodTypeAny;
  tier: Tier;
  /** For the integrations boot line: group label (defaults to the var name). */
  integration?: string;
};

const trimmedNonEmpty = z.string().trim().min(1);

const ENV_SPECS: Record<string, EnvSpec> = {
  // ---- required ------------------------------------------------------------
  DATABASE_URL: { schema: trimmedNonEmpty, tier: "required" },
  PORT: { schema: intString, tier: "required" },

  // ---- integrations (presence = on) ----------------------------------------
  WEATHER_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "weather" },
  SERPER_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "serper" },
  SERPER_API_KEYS: { schema: trimmedNonEmpty, tier: "integration", integration: "serper" },
  REMOVE_BG_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "remove-bg" },
  REMOVE_BG_API_KEYS: { schema: trimmedNonEmpty, tier: "integration", integration: "remove-bg" },
  JINA_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "jina" },
  OPENAI_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "openai" },
  GEMINI_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "gemini" },
  GOOGLE_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "gemini" },
  OPENROUTER_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "beam-openrouter" },
  ANTHROPIC_API_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "beam-anthropic" },
  GOOGLE_CLIENT_ID: { schema: trimmedNonEmpty, tier: "integration", integration: "google-oauth" },
  GOOGLE_CLIENT_SECRET: { schema: trimmedNonEmpty, tier: "integration", integration: "google-oauth" },
  FIREBASE_PROJECT_ID: { schema: trimmedNonEmpty, tier: "integration", integration: "firebase" },
  FIREBASE_CLIENT_EMAIL: { schema: trimmedNonEmpty, tier: "integration", integration: "firebase" },
  FIREBASE_PRIVATE_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "firebase" },
  FIREBASE_STORAGE_BUCKET: { schema: trimmedNonEmpty, tier: "integration", integration: "firebase-storage" },
  FIREBASE_STORAGE_PUBLIC_BASE_URL: { schema: urlString, tier: "integration", integration: "firebase-storage" },
  SUPABASE_URL: { schema: urlString, tier: "integration", integration: "supabase-storage" },
  SUPABASE_SERVICE_ROLE_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "supabase-storage" },
  SUPABASE_IMAGE_BUCKET: { schema: trimmedNonEmpty, tier: "integration", integration: "supabase-storage" },
  SUPABASE_IMAGE_PUBLIC_URL_BASE: { schema: urlString, tier: "integration", integration: "supabase-storage" },
  REDIS_URL: { schema: trimmedNonEmpty, tier: "integration", integration: "redis" },
  SENTRY_DSN: { schema: urlString, tier: "integration", integration: "sentry" },
  ADMIN_SECRET: { schema: trimmedNonEmpty, tier: "integration", integration: "admin-ops" },
  ADMIN_EMAILS: { schema: trimmedNonEmpty, tier: "integration", integration: "admin-ops" },
  VAPID_PUBLIC_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "web-push" },
  VAPID_PRIVATE_KEY: { schema: trimmedNonEmpty, tier: "integration", integration: "web-push" },
  VAPID_SUBJECT: { schema: trimmedNonEmpty, tier: "integration", integration: "web-push" },
  RAKUTEN_ADVERTISING_CLIENT_ID: { schema: trimmedNonEmpty, tier: "integration", integration: "rakuten" },
  RAKUTEN_ADVERTISING_CLIENT_SECRET: { schema: trimmedNonEmpty, tier: "integration", integration: "rakuten" },
  RAKUTEN_ADVERTISING_SID: { schema: trimmedNonEmpty, tier: "integration", integration: "rakuten" },
  AMAZON_ASSOCIATE_TAG: { schema: trimmedNonEmpty, tier: "integration", integration: "amazon-affiliate" },
  DATABASE_SSL_CA: { schema: trimmedNonEmpty, tier: "integration", integration: "db-tls-verified" },
  BEAM_AGENT_TOKEN_SECRET: { schema: trimmedNonEmpty, tier: "integration", integration: "beam-mcp" },
  BEAM_OBSERVATORY_TOKEN: { schema: trimmedNonEmpty, tier: "integration", integration: "beam-observatory" },

  // ---- shape-checked flags (strict `=== "true"` call sites) -----------------
  HSTS_ENABLED: { schema: strictBool, tier: "shape" },
  RUN_MIGRATIONS_ON_BOOT: { schema: strictBool, tier: "shape" },
  ENABLE_REIMAGINE: { schema: strictBool, tier: "shape" },
  AMAZON_AFFILIATE_ENABLED: { schema: strictBool, tier: "shape" },
  DATABASE_SSL_REJECT_UNAUTHORIZED: { schema: strictBool, tier: "shape" },

  // ---- shape-checked flags (loose /^(1|true|yes|on)$/i call sites) ----------
  ENRICHMENT_QUEUE_ENABLED: { schema: looseBool, tier: "shape" },
  ENRICHMENT_WORKER_ENABLED: { schema: looseBool, tier: "shape" },
  IMAGE_ALLOW_LOCAL_OBJECT_STORAGE: { schema: looseBool, tier: "shape" },
  BEAM_AGENT_ENABLED: { schema: z.string(), tier: "shape" }, // accepts disabled/off/no — any string is meaningful
  BEAM_RESEARCH_ENABLED: { schema: looseBool, tier: "shape" },
  BEAM_DISCOVER_EXTERNAL_ENABLED: { schema: looseBool, tier: "shape" },

  // ---- shape-checked numbers -------------------------------------------------
  TRUST_PROXY_HOPS: { schema: intString, tier: "shape" },
  SHARP_CONCURRENCY: { schema: intString, tier: "shape" },
  TOKEN_ABSOLUTE_TTL_DAYS: { schema: numberString, tier: "shape" },
  TOKEN_IDLE_TTL_DAYS: { schema: numberString, tier: "shape" },
  OAUTH_RATE_LIMIT: { schema: intString, tier: "shape" },
  SCENT_PROFILE_RATE_LIMIT: { schema: intString, tier: "shape" },
  SEARCH_SCENT_RATE_LIMIT: { schema: intString, tier: "shape" },
  REFRESH_IMAGE_RATE_LIMIT: { schema: intString, tier: "shape" },
  SCENT_FACTS_RATE_LIMIT: { schema: intString, tier: "shape" },
  REVIEWS_SUMMARIZE_RATE_LIMIT: { schema: intString, tier: "shape" },
  REIMAGINE_RATE_LIMIT_PER_HOUR: { schema: intString, tier: "shape" },
  DATABASE_POOL_MAX: { schema: intString, tier: "shape" },
  DATABASE_CONNECTION_TIMEOUT_MS: { schema: intString, tier: "shape" },
  DATABASE_IDLE_TIMEOUT_MS: { schema: intString, tier: "shape" },
  BUY_LINK_CACHE_TTL_MS: { schema: intString, tier: "shape" },
  IMAGE_PROXY_CACHE_MAX_BYTES: { schema: intString, tier: "shape" },
  IMAGE_PROXY_CACHE_TTL_MS: { schema: intString, tier: "shape" },
  IMAGE_PROXY_MAX_CONCURRENCY: { schema: intString, tier: "shape" },
  IMAGE_PROXY_MAX_QUEUE: { schema: intString, tier: "shape" },
  IMAGE_PIPELINE_MAX_CONCURRENCY: { schema: intString, tier: "shape" },
  IMAGE_FAILED_STATUS_RETRY_MS: { schema: intString, tier: "shape" },
  ENRICHMENT_WORKER_POLL_MS: { schema: intString, tier: "shape" },
  ENRICHMENT_WORKER_BATCH: { schema: intString, tier: "shape" },
  ENRICHMENT_RESOLVE_TIMEOUT_MS: { schema: intString, tier: "shape" },
  ENRICHMENT_FAILED_RETRY_SWEEP_MS: { schema: intString, tier: "shape" },
  ENRICHMENT_FAILED_RETRY_MS: { schema: intString, tier: "shape" },
  ENRICHMENT_CLAIM_LEASE_MS: { schema: intString, tier: "shape" },
  ENGINE_RESOLVE_TIMEOUT_MS: { schema: intString, tier: "shape" },
  BEAM_USER_DAILY_SPEND_USD: { schema: numberString, tier: "shape" },
  BEAM_USER_DAILY_RUN_CAP: { schema: intString, tier: "shape" },
  BEAM_OWNER_TOKEN_TTL_DAYS: { schema: numberString, tier: "shape" },
  BEAM_EXTERNAL_DETAIL_RUN_CAP: { schema: intString, tier: "shape" },
  BEAM_DISCOVER_SEARCH_TIMEOUT_MS: { schema: intString, tier: "shape" },
  BEAM_DISCOVER_DETAIL_TIMEOUT_MS: { schema: intString, tier: "shape" },
  BEAM_ENRICHMENT_MAX_ATTEMPTS: { schema: intString, tier: "shape" },
  BEAM_MCP_PORT: { schema: intString, tier: "shape" },
  BEAM_MCP_DETAIL_REFILL_MS: { schema: intString, tier: "shape" },
  BEAM_AGENT_MAX_TURNS_DEFAULT: { schema: intString, tier: "shape" },
  BEAM_AGENT_MAX_TURNS_PREMIUM: { schema: intString, tier: "shape" },
  BEAM_AGENT_ORCH_MAX_TOKENS: { schema: intString, tier: "shape" },
  BEAM_AGENT_SYNTH_MAX_TOKENS: { schema: intString, tier: "shape" },

  // ---- shape-checked URLs ----------------------------------------------------
  FRAGRANCE_ENGINE_URL: { schema: urlString, tier: "shape" },
  VITE_FRAGRANCE_API_URL: { schema: urlString, tier: "shape" },
  OAUTH_PUBLIC_URL: { schema: urlString, tier: "shape" },
  PUBLIC_APP_URL: { schema: urlString, tier: "shape" },
  FRONTEND_URL: { schema: urlString, tier: "shape" },
};

/**
 * Prefixes owned by this app. A set var matching one of these that is NOT in
 * the schema is probably a typo'd or stale name — worth one warning line.
 */
const OWNED_PREFIXES = [
  "BEAM_",
  "ENRICHMENT_",
  "IMAGE_",
  "SERPER_",
  "REMOVE_BG_",
  "RAKUTEN_",
  "AMAZON_",
  "FIREBASE_",
  "SUPABASE_",
  "VAPID_",
  "TOKEN_",
  "OAUTH_",
  "ADMIN_",
  "DATABASE_",
  "SENTRY_",
  "CORS_",
  "HSTS_",
  "TRUST_PROXY_",
  "OPENAI_REIMAGINE_",
  "SCENT_",
];

/** Vars legitimately read elsewhere (or by the platform) — never "unknown". */
const KNOWN_EXTRA = new Set([
  "CORS_ALLOWED_ORIGINS",
  "DATABASE_SSL_CA",
  "ADMIN_EMAILS",
  "ADMIN_SECRET",
  "SCENT_FACTS_RATE_LIMIT",
  "SCENT_PROFILE_RATE_LIMIT",
  "OPENAI_REIMAGINE_MODEL",
  "OPENAI_REIMAGINE_QUALITY",
  "OPENAI_REIMAGINE_INPUT_DIM",
  "IMAGE_PROVIDER",
  "IMAGE_VISION_GATE",
  "IMAGE_LOCAL_STORAGE_DIR",
  "BEAM_AGENT_PROVIDER",
  "BEAM_AGENT_MODEL",
  "BEAM_AGENT_MODEL_STRONG",
  "BEAM_AGENT_MODEL_DEEP",
  "BEAM_AGENT_MODEL_PREMIUM",
  "BEAM_AGENT_SYNTH_MODEL_DEFAULT",
  "BEAM_AGENT_SYNTH_MODEL_PREMIUM",
  "BEAM_RESEARCH_ENGINE",
  "BEAM_RESEARCH_INCLUDE_DOMAINS",
  "BEAM_MCP_HOST",
  "BEAM_OWNER_USER_ID",
  "BEAM_OWNER_TENANT_ID",
  "AMAZON_MARKETPLACE",
  "AMAZON_ACCESS_KEY_ID",
  "AMAZON_SECRET_ACCESS_KEY",
  "AMAZON_PARTNER_TAG",
  "AMAZON_PARTNER_TYPE",
  "AMAZON_REGION",
  "RAKUTEN_ADVERTISING_BASE_URL",
  "RAKUTEN_ADVERTISING_MIDS",
  "RAKUTEN_ADVERTISING_U1",
  "RAKUTEN_ADVERTISING_PRODUCT_MAX",
  "RAKUTEN_ADVERTISING_ACCESS_TOKEN",
  "RAKUTEN_API_ACCESS_TOKEN",
  "RAKUTEN_ADVERTISER_MIDS",
  "DATABASE_URL",
  "DATABASE_SSL_REJECT_UNAUTHORIZED",
  "TOKEN_ABSOLUTE_TTL_DAYS",
  "TOKEN_IDLE_TTL_DAYS",
  "OAUTH_PUBLIC_URL",
  "OAUTH_RATE_LIMIT",
  "TRUST_PROXY_HOPS",
  "SENTRY_DSN",
  "HSTS_ENABLED",
]);

export type EnvReport = {
  fatal: string[];
  warnings: string[];
  integrationsOn: string[];
  integrationsOff: string[];
};

export function validateEnv(env: Record<string, string | undefined> = process.env): EnvReport {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const integrationState = new Map<string, boolean>();

  for (const [name, spec] of Object.entries(ENV_SPECS)) {
    const raw = env[name];
    const isSet = raw !== undefined && raw.trim() !== "";

    if (spec.tier === "required") {
      if (!isSet) {
        fatal.push(`${name} is required but not set`);
        continue;
      }
    }

    if (spec.integration) {
      const group = spec.integration;
      integrationState.set(group, (integrationState.get(group) ?? false) || isSet);
    }

    if (!isSet) continue;
    const result = spec.schema.safeParse(raw.trim());
    if (!result.success) {
      const issue = result.error.issues[0]?.message ?? "invalid";
      const message = `${name}=${JSON.stringify(raw)} is malformed (${issue})`;
      if (spec.tier === "required") fatal.push(message);
      else warnings.push(message);
    }
  }

  // Unknown-var sweep: owned-prefix vars that match nothing we know about.
  for (const name of Object.keys(env)) {
    if (name in ENV_SPECS || KNOWN_EXTRA.has(name)) continue;
    if (!OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (env[name] === undefined || env[name] === "") continue;
    warnings.push(`${name} is set but matches no known variable — possible typo or stale name`);
  }

  const integrationsOn = [...integrationState.entries()].filter(([, on]) => on).map(([g]) => g).sort();
  const integrationsOff = [...integrationState.entries()].filter(([, on]) => !on).map(([g]) => g).sort();
  return { fatal, warnings, integrationsOn, integrationsOff };
}

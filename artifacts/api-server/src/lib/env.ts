// Boot-time environment validation (production-readiness G2).
//
// This is a VISIBILITY layer, not a migration of every call site: existing
// code keeps reading `process.env` directly (each with its own established
// default/degrade behavior), and this module runs once at boot to catch the
// mistakes that behavior can't: a missing required var (fail loud, not with a
// mystery 500 on the first request), a flag set to a value nobody's parser
// recognizes (warn, don't silently treat as off), and an unknown var that
// looks like it was meant for this app (typo'd name, never read by anything).
//
// Call `validateEnv()` once, as early as possible after env-bootstrap's dotenv
// load — see index.ts. Kept out of env-bootstrap.ts itself, which deliberately
// stays dependency-free (its own header comment) since ESM evaluates imports
// before any statement runs and its dotenv side effects must land first.
import { z } from "zod";
import { logger } from "./logger.ts";

// Generously permissive so we only warn on values NO call site's parser
// recognizes. Different flags accept different subsets of this (some check
// only "true", others accept off/0/no) — this catches real typos ("tru",
// "enabled") without false-alarming on any value actually in use today.
const FLAG_VALUES = new Set(["true", "false", "1", "0", "on", "off", "yes", "no"]);

const FLAGS = [
  "AMAZON_AFFILIATE_ENABLED",
  "BEAM_AGENT_ENABLED",
  "BEAM_DISCOVER_EXTERNAL_ENABLED",
  "BEAM_OBSERVATORY_ENABLED",
  "BEAM_RESEARCH_ENABLED",
  "ENABLE_REIMAGINE",
  "ENRICHMENT_QUEUE_ENABLED",
  "ENRICHMENT_WORKER_ENABLED",
  "HSTS_ENABLED",
  "IMAGE_ALLOW_LOCAL_OBJECT_STORAGE",
] as const;

// One boot-time summary line per logical integration, generalizing the
// existing Beam-provider canary (provider.ts) to every optional integration.
// `vars` are the env vars that switch the integration on; `flag` (if set) is
// checked with the same permissive FLAG_VALUES vocabulary as a plain ON/OFF
// switch — otherwise "configured" just means at least one listed var is set.
const INTEGRATIONS: { name: string; vars: string[]; flag?: string }[] = [
  { name: "Database TLS verification", vars: ["DATABASE_SSL_CA"] },
  { name: "Redis (shared rate limits + Beam session memory)", vars: ["REDIS_URL"] },
  { name: "Google OAuth", vars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] },
  {
    name: "Image storage (Firebase)",
    vars: ["FIREBASE_STORAGE_BUCKET", "FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL"],
  },
  {
    name: "Image storage (Supabase)",
    vars: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_IMAGE_BUCKET"],
  },
  { name: "Image search (Serper)", vars: ["SERPER_API_KEY", "SERPER_API_KEYS"] },
  { name: "Background removal (Poof)", vars: ["REMOVE_BG_API_KEY", "REMOVE_BG_API_KEYS"] },
  { name: "Image vision gate (Gemini)", vars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { name: "Reimagine (OpenAI)", vars: ["OPENAI_API_KEY"], flag: "ENABLE_REIMAGINE" },
  { name: "Weather (paid provider)", vars: ["WEATHER_API_KEY"] },
  {
    name: "Beam Agent model provider",
    vars: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"],
    flag: "BEAM_AGENT_ENABLED",
  },
  { name: "Beam web research", vars: ["OPENROUTER_API_KEY"], flag: "BEAM_RESEARCH_ENABLED" },
  { name: "Beam observatory feed", vars: ["BEAM_OBSERVATORY_TOKEN"], flag: "BEAM_OBSERVATORY_ENABLED" },
  {
    name: "Enrichment queue",
    vars: ["ENRICHMENT_QUEUE_ENABLED", "ENRICHMENT_WORKER_ENABLED"],
  },
  { name: "Web push (VAPID)", vars: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] },
  { name: "Rakuten affiliate", vars: ["RAKUTEN_ADVERTISING_CLIENT_ID", "RAKUTEN_API_ACCESS_TOKEN"] },
  { name: "Amazon affiliate", vars: ["AMAZON_ASSOCIATE_TAG"], flag: "AMAZON_AFFILIATE_ENABLED" },
  { name: "Admin routes", vars: ["ADMIN_EMAILS", "ADMIN_SECRET"] },
  { name: "CORS allowlist", vars: ["CORS_ALLOWED_ORIGINS"] },
  { name: "Boot-time DB migrations", vars: ["RUN_MIGRATIONS_ON_BOOT"] },
];

// Every var this package is known to read (directly or via a passed-through
// `process.env`), across every prefix below — used only for the unknown-var
// typo check, not for tiered parsing. New vars should be added here alongside
// their first call site.
const KNOWN_PREFIXES = ["BEAM_", "AMAZON_", "RAKUTEN_", "IMAGE_", "ENRICHMENT_", "SCENT_"];
const KNOWN_VARS = new Set([
  "ADMIN_EMAILS",
  "ADMIN_SECRET",
  "AMAZON_AFFILIATE_ENABLED",
  "AMAZON_ASSOCIATE_TAG",
  "AMAZON_MARKETPLACE",
  "ANTHROPIC_API_KEY",
  "APP_BASE_DOMAIN",
  "BEAM_AGENT_ENABLED",
  "BEAM_AGENT_MAX_TURNS_DEFAULT",
  "BEAM_AGENT_MAX_TURNS_PREMIUM",
  "BEAM_AGENT_MODEL",
  "BEAM_AGENT_MODEL_DEEP",
  "BEAM_AGENT_MODEL_PREMIUM",
  "BEAM_AGENT_MODEL_STRONG",
  "BEAM_AGENT_ORCH_MAX_TOKENS",
  "BEAM_AGENT_PROVIDER",
  "BEAM_AGENT_SYNTH_MAX_TOKENS",
  "BEAM_AGENT_SYNTH_MODEL_DEFAULT",
  "BEAM_AGENT_SYNTH_MODEL_PREMIUM",
  "BEAM_AGENT_TOKEN_SECRET",
  "BEAM_DISCOVER_DETAIL_TIMEOUT_MS",
  "BEAM_DISCOVER_EXTERNAL_ENABLED",
  "BEAM_DISCOVER_SEARCH_TIMEOUT_MS",
  "BEAM_ENRICHMENT_MAX_ATTEMPTS",
  "BEAM_EXTERNAL_DETAIL_RUN_CAP",
  "BEAM_MCP_DETAIL_REFILL_MS",
  "BEAM_MCP_HOST",
  "BEAM_MCP_PORT",
  "BEAM_OBSERVATORY_ENABLED",
  "BEAM_OBSERVATORY_TOKEN",
  "BEAM_OWNER_TENANT_ID",
  "BEAM_OWNER_TOKEN_TTL_DAYS",
  "BEAM_OWNER_USER_ID",
  "BEAM_RESEARCH_ENABLED",
  "BEAM_RESEARCH_ENGINE",
  "BEAM_RESEARCH_INCLUDE_DOMAINS",
  "BEAM_USER_DAILY_RUN_CAP",
  "BEAM_USER_DAILY_SPEND_USD",
  "BUY_LINK_CACHE_TTL_MS",
  "CORS_ALLOWED_ORIGINS",
  "COMMUNITY_WRITE_RATE_LIMIT",
  "DATABASE_CONNECTION_TIMEOUT_MS",
  "DATABASE_IDLE_TIMEOUT_MS",
  "DATABASE_POOL_MAX",
  "DATABASE_SSL_CA",
  "DATABASE_SSL_REJECT_UNAUTHORIZED",
  "DATABASE_URL",
  "DEFAULT_TENANT_SLUG",
  "ENABLE_REIMAGINE",
  "ENGINE_RESOLVE_TIMEOUT_MS",
  "ENRICHMENT_CLAIM_LEASE_MS",
  "ENRICHMENT_FAILED_RETRY_MS",
  "ENRICHMENT_FAILED_RETRY_SWEEP_MS",
  "ENRICHMENT_QUEUE_ENABLED",
  "ENRICHMENT_RESOLVE_TIMEOUT_MS",
  "ENRICHMENT_WORKER_BATCH",
  "ENRICHMENT_WORKER_ENABLED",
  "ENRICHMENT_WORKER_POLL_MS",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_STORAGE_PUBLIC_BASE_URL",
  "FRAGRANCE_ENGINE_URL",
  "FRONTEND_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "HSTS_ENABLED",
  "IMAGE_ALLOW_LOCAL_OBJECT_STORAGE",
  "IMAGE_FAILED_STATUS_RETRY_MS",
  "IMAGE_LOCAL_STORAGE_DIR",
  "IMAGE_PIPELINE_MAX_CONCURRENCY",
  "IMAGE_PROVIDER",
  "IMAGE_PROXY_CACHE_MAX_BYTES",
  "IMAGE_PROXY_CACHE_TTL_MS",
  "IMAGE_PROXY_MAX_CONCURRENCY",
  "IMAGE_PROXY_MAX_QUEUE",
  "IMAGE_VISION_GATE",
  "JINA_API_KEY",
  "LOG_LEVEL",
  "MIGRATIONS_DIR",
  "NODE_ENV",
  "OAUTH_PUBLIC_URL",
  "OAUTH_RATE_LIMIT",
  "OPENAI_API_KEY",
  "OPENAI_REIMAGINE_INPUT_DIM",
  "OPENAI_REIMAGINE_MODEL",
  "OPENAI_REIMAGINE_QUALITY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_APP_TITLE",
  "OPENROUTER_SITE_URL",
  "PORT",
  "PUBLIC_APP_URL",
  "RAKUTEN_ADVERTISER_MIDS",
  "RAKUTEN_ADVERTISING_ACCESS_TOKEN",
  "RAKUTEN_ADVERTISING_BASE_URL",
  "RAKUTEN_ADVERTISING_CLIENT_ID",
  "RAKUTEN_ADVERTISING_CLIENT_SECRET",
  "RAKUTEN_ADVERTISING_MIDS",
  "RAKUTEN_ADVERTISING_PRODUCT_MAX",
  "RAKUTEN_ADVERTISING_SID",
  "RAKUTEN_ADVERTISING_U1",
  "RAKUTEN_API_ACCESS_TOKEN",
  "REDIS_URL",
  "REFRESH_IMAGE_RATE_LIMIT",
  "REIMAGINE_RATE_LIMIT_PER_HOUR",
  "REMOVE_BG_API_KEY",
  "REMOVE_BG_API_KEYS",
  "REPLIT_DEV_DOMAIN",
  "REPLIT_DOMAINS",
  "REVIEWS_SUMMARIZE_RATE_LIMIT",
  "RUN_MIGRATIONS_ON_BOOT",
  "SCENT_FACTS_RATE_LIMIT",
  "SCENT_PROFILE_RATE_LIMIT",
  "SEARCH_SCENT_RATE_LIMIT",
  "SERPER_API_KEY",
  "SERPER_API_KEYS",
  "SERPER_IMAGE_API_URL",
  "SHARP_CONCURRENCY",
  "SUPABASE_IMAGE_BUCKET",
  "SUPABASE_IMAGE_PUBLIC_URL_BASE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "TOKEN_ABSOLUTE_TTL_DAYS",
  "TOKEN_IDLE_TTL_DAYS",
  "TRUST_PROXY_HOPS",
  "VAPID_PRIVATE_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT",
  "VITE_FRAGRANCE_API_URL",
  "WARDROBE_WRITE_RATE_LIMIT",
  "WEATHER_API_KEY",
]);

const requiredSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL must be set. Did you forget to provision a database?"),
  PORT: z.string().min(1, "PORT must be set."),
});

/**
 * Boot-time validation pass. Never throws: a missing REQUIRED var exits the
 * process directly (matching the existing fail-fast behavior in index.ts /
 * @workspace/db, just surfaced before any other boot work runs), everything
 * else is a `logger.warn` — this module adds visibility, it does not change
 * what already degrades gracefully.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const required = requiredSchema.safeParse(env);
  if (!required.success) {
    for (const issue of required.error.issues) {
      const envVar = issue.path.join(".") || "(unknown)";
      logger.fatal(
        { envVar, reason: issue.message },
        `env: ${envVar} is missing or invalid; refusing to boot`,
      );
    }
    process.exit(1);
  }

  for (const envVar of FLAGS) {
    const raw = env[envVar];
    if (raw !== undefined && raw !== "" && !FLAG_VALUES.has(raw.trim().toLowerCase())) {
      logger.warn(
        { envVar, value: raw },
        `env: ${envVar} is set to a value no known parser recognizes as on/off — check for a typo (expected one of: true/false/1/0/on/off/yes/no)`,
      );
    }
  }

  const unknown = Object.keys(env).filter(
    (name) =>
      KNOWN_PREFIXES.some((prefix) => name.startsWith(prefix)) && !KNOWN_VARS.has(name),
  );
  if (unknown.length > 0) {
    logger.warn(
      { vars: unknown },
      "env: unrecognized variable(s) matching a known ScentCast prefix — likely a typo of a real var name (never read by anything)",
    );
  }

  const configured = INTEGRATIONS.map(({ name, vars, flag }) => {
    const hasVars = vars.some((v) => Boolean(env[v]?.trim()));
    const explicitlyOff = flag !== undefined && env[flag]?.trim().toLowerCase() === "false";
    return { name, on: hasVars && !explicitlyOff };
  });
  logger.info(
    {
      integrations: Object.fromEntries(configured.map(({ name, on }) => [name, on])),
    },
    "env: optional integrations at boot",
  );
}

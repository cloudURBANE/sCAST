/**
 * Beam research lane — OpenRouter web-search provider (the only network module).
 *
 * Calls OpenRouter's Chat Completions API with the `web` plugin pinned to an
 * explicit engine + result count + domain allowlist — the cost-control surface
 * the spec requires. We deliberately do NOT use `:online`, `openrouter/auto`,
 * or `openrouter/fusion` (banned in researchPolicy). The plugin form is older
 * than OpenRouter's newer `tools:[{type:"openrouter:web_search"}]` shape, but it
 * exposes engine/max_results/include_domains directly, which is what we need.
 *
 * The credential is read from the environment and never returned to a tool or
 * the client. No new dependency (plain `fetch`), matching openRouterProvider.ts.
 */
import type { ResearchSource, ResearchSourceType } from "./researchPolicy.ts";
import { estimateCostUsd } from "./researchPolicy.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const RESEARCH_TIMEOUT_MS = 30_000;

const RESEARCH_SYSTEM =
  "You are a fragrance research assistant. Use ONLY the provided web results. " +
  "Answer in 1-3 sentences with the specific fact asked for (price, availability, " +
  "perfumer, release year, concentration, seller, etc.). State plainly when the " +
  "results don't contain the answer. Never invent facts, prices, or sources. " +
  "Do not add caveats, marketing language, or recommendations.";

const SEARCH_PROMPT = "Relevant, current web results for this fragrance question:";

export type WebResearchInput = {
  query: string;
  model: string;
  engine: string;
  includeDomains: string[];
  maxResults: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type WebResearchOutput = {
  synthesizedFact: string;
  sources: ResearchSource[];
  confidence: number;
  costUsd: number;
  model: string;
  engine: string;
};

/* ------------------------------------------------------------------ */
/* OpenRouter wire shapes (minimal)                                    */
/* ------------------------------------------------------------------ */

type UrlCitation = { url?: string; title?: string; content?: string };
type Annotation = { type?: string; url_citation?: UrlCitation };
type OpenRouterResearchResponse = {
  choices?: Array<{ message?: { content?: string | null; annotations?: Annotation[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/* ------------------------------------------------------------------ */
/* Source classification + confidence                                  */
/* ------------------------------------------------------------------ */

const DATABASE_HOSTS = ["fragrantica.com", "parfumo.com", "basenotes.com"];
const RETAILER_HOSTS = ["luckyscent.com", "surrendertochance", "scentsplit", "twistedlily", "amazon.", "sephora.", "fragrancenet"];
const FORUM_HOSTS = ["reddit.com", "basenotes.com/community", "fragrancecommunity"];

function classifySource(url: string): ResearchSourceType {
  const u = url.toLowerCase();
  if (FORUM_HOSTS.some((h) => u.includes(h))) return "forum";
  if (DATABASE_HOSTS.some((h) => u.includes(h))) return "database";
  if (RETAILER_HOSTS.some((h) => u.includes(h))) return "retailer";
  if (/\breview\b|fragrancebattle|persolaise/.test(u)) return "review";
  return "unknown";
}

function parseSources(annotations: Annotation[] | undefined, retrievedAt: string): ResearchSource[] {
  if (!Array.isArray(annotations)) return [];
  const out: ResearchSource[] = [];
  const seen = new Set<string>();
  for (const ann of annotations) {
    if (ann?.type !== "url_citation" || !ann.url_citation?.url) continue;
    const url = ann.url_citation.url;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: (ann.url_citation.title ?? "").slice(0, 200),
      excerpt: (ann.url_citation.content ?? "").slice(0, 500),
      sourceType: classifySource(url),
      retrievedAt,
    });
    if (out.length >= 10) break;
  }
  return out;
}

function confidenceFor(sources: ResearchSource[], hasText: boolean): number {
  if (!hasText) return 0.2;
  if (sources.length === 0) return 0.4;
  return Math.min(0.9, 0.45 + sources.length * 0.12);
}

/* ------------------------------------------------------------------ */
/* The call                                                            */
/* ------------------------------------------------------------------ */

export async function runWebResearch(input: WebResearchInput): Promise<WebResearchOutput> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "X-Title": process.env.OPENROUTER_APP_TITLE?.trim() || "ScentBeam Beam Agent",
  };
  const referer = process.env.OPENROUTER_SITE_URL?.trim();
  if (referer) headers["HTTP-Referer"] = referer;

  const webPlugin: Record<string, unknown> = {
    id: "web",
    engine: input.engine,
    max_results: input.maxResults,
    search_prompt: SEARCH_PROMPT,
  };
  if (input.includeDomains.length > 0) webPlugin.include_domains = input.includeDomains;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    signal: input.signal ?? AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxOutputTokens,
      messages: [
        { role: "system", content: RESEARCH_SYSTEM },
        { role: "user", content: input.query },
      ],
      plugins: [webPlugin],
      usage: { include: true },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter research failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenRouterResearchResponse;
  const message = data.choices?.[0]?.message;
  const text = (message?.content ?? "").trim();
  const retrievedAt = new Date().toISOString();
  const sources = parseSources(message?.annotations, retrievedAt);

  const costUsd =
    typeof data.usage?.cost === "number"
      ? Number(data.usage.cost.toFixed(6))
      : estimateCostUsd({
          model: input.model,
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          maxResults: input.maxResults,
        });

  return {
    synthesizedFact: text,
    sources,
    confidence: confidenceFor(sources, text.length > 0),
    costUsd,
    model: input.model,
    engine: input.engine,
  };
}

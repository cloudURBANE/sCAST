import { logger } from "../lib/logger";
import {
  BaseNotesError,
  isAllowedBaseNotesUrl,
  parseBaseNotesDetailHtml,
  parseBaseNotesSearchHtml,
  sanitizeBaseNotesQuery,
  type BaseNotesCandidate,
  type BaseNotesDetail,
} from "./baseNotesParser";

export {
  BaseNotesError,
  buildSearchLabel,
  isAllowedBaseNotesUrl,
  normalizeSelectedIdentity,
  parseBaseNotesDetailHtml,
  parseBaseNotesSearchHtml,
  sanitizeBaseNotesQuery,
  type BaseNotesCandidate,
  type BaseNotesDetail,
  type BaseNotesNoteGroups,
  type BaseNotesNotes,
  type NormalizedSelectedIdentity,
} from "./baseNotesParser";

const FETCH_TIMEOUT_MS = 8_000;
const FETCH_MAX_BYTES = 1_500_000;
const FETCH_RETRIES = 1;
const REQUEST_USER_AGENT =
  "Mozilla/5.0 (compatible; ScentCastBot/1.0; +https://scentcast.app)";

const SEARCH_URL_TEMPLATE =
  process.env.BASENOTES_SEARCH_URL_TEMPLATE ??
  "https://basenotes.com/search?q={query}";

async function fetchTextWithTimeout(url: string, attempt = 0): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": REQUEST_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      throw new BaseNotesError(`HTTP ${res.status}`, res.status >= 500 ? 502 : 404);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      throw new BaseNotesError("Empty response body");
    }
    const decoder = new TextDecoder();
    let total = 0;
    let html = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > FETCH_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new BaseNotesError("Response too large");
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
    return html;
  } catch (err: unknown) {
    if (attempt < FETCH_RETRIES && !(err instanceof BaseNotesError)) {
      return fetchTextWithTimeout(url, attempt + 1);
    }
    if (err instanceof BaseNotesError) throw err;
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "BaseNotes request timed out"
        : "BaseNotes request failed";
    throw new BaseNotesError(reason);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchBaseNotesDirectory(query: string): Promise<BaseNotesCandidate[]> {
  const cleaned = sanitizeBaseNotesQuery(query);
  if (!cleaned) {
    throw new BaseNotesError("Query is required", 400);
  }
  const url = SEARCH_URL_TEMPLATE.replace("{query}", encodeURIComponent(cleaned));
  try {
    const html = await fetchTextWithTimeout(url);
    return parseBaseNotesSearchHtml(html, url);
  } catch (err: unknown) {
    if (err instanceof BaseNotesError) throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[basenotes] search failed",
    );
    throw new BaseNotesError("BaseNotes search failed");
  }
}

export async function fetchBaseNotesDetail(url: string): Promise<BaseNotesDetail> {
  if (!isAllowedBaseNotesUrl(url)) {
    throw new BaseNotesError("URL is not an allowed BaseNotes fragrance page", 400);
  }
  try {
    const html = await fetchTextWithTimeout(url);
    return parseBaseNotesDetailHtml(html, url);
  } catch (err: unknown) {
    if (err instanceof BaseNotesError) throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), url },
      "[basenotes] detail fetch failed",
    );
    throw new BaseNotesError("BaseNotes detail fetch failed");
  }
}

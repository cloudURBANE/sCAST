import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { fragranceReviewSummariesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { makeLookupKey } from "./catalogService";

const LLM_TIMEOUT_MS = 20_000;
const MAX_INPUT_REVIEWS = 24;
const MAX_OUTPUT_COMMENTS = 8;

export type RawReview = { text: string; source?: string };

export type SummarizedComment = {
  text: string;
  theme: "performance" | "season" | "vibe" | "general";
};

export type ReviewSummaryResult = {
  comments: SummarizedComment[];
  cached: boolean;
};

function cleanJson(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function normalizeReviews(reviews: RawReview[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const review of reviews) {
    const text = typeof review?.text === "string" ? review.text.replace(/\s+/g, " ").trim() : "";
    if (text.length < 8) continue;
    const key = text.slice(0, 280).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_INPUT_REVIEWS) break;
  }
  return out;
}

function hashReviews(texts: string[]): string {
  return createHash("sha256").update(texts.join("\0")).digest("hex").slice(0, 32);
}

function prompt(fragranceName: string, reviews: string[]): string {
  const reviewBlock = reviews.map((r, i) => `REVIEW ${i + 1}: ${r.slice(0, 1200)}`).join("\n\n");
  return `
You are an editor writing short comment-style blurbs for a fragrance website product page.
Below are raw, scraped user reviews for "${fragranceName}".

Rewrite the overall sentiment into ${MAX_OUTPUT_COMMENTS} short, original comments.

Rules:
- Each comment is ONE punchy sentence, roughly 8-18 words.
- Capture genuine consensus (performance, vibe, seasons, drydown).
- ORIGINAL phrasing only; never quote verbatim.
- No emojis, hashtags, usernames, ratings, or markdown.
- Categorize each comment with a theme: "performance", "season", "vibe", or "general".
- Return raw JSON only matching the schema exactly.

JSON shape:
{
  "comments": [
    { "text": "Comment text here", "theme": "performance" },
    { "text": "Another comment text", "theme": "vibe" }
  ]
}

Reviews:
${reviewBlock}
`;
}

function geminiApiKey(): string {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    ""
  );
}

async function generateWithGemini(fragranceName: string, reviews: string[]): Promise<SummarizedComment[]> {
  const apiKey = geminiApiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY)");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(fragranceName, reviews) }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini review summary failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Gemini returned empty output.");
  }

  const parsed = JSON.parse(cleanJson(text)) as unknown;
  const rawComments = Array.isArray(parsed)
    ? parsed
    : (parsed as { comments?: unknown })?.comments;
  if (!Array.isArray(rawComments)) return [];

  const validThemes = ["performance", "season", "vibe", "general"];

  return rawComments
    .map((c): SummarizedComment | null => {
      if (typeof c === "string") {
        return { text: c.replace(/\s+/g, " ").trim(), theme: "general" };
      }
      if (c && typeof c === "object" && "text" in c && typeof (c as any).text === "string") {
        const textVal = (c as any).text.replace(/\s+/g, " ").trim();
        const rawTheme = (c as any).theme;
        const themeVal = typeof rawTheme === "string" && validThemes.includes(rawTheme.toLowerCase())
          ? (rawTheme.toLowerCase() as SummarizedComment["theme"])
          : "general";
        return { text: textVal, theme: themeVal };
      }
      return null;
    })
    .filter((c): c is SummarizedComment => c !== null && c.text.length >= 8)
    .slice(0, MAX_OUTPUT_COMMENTS);
}

export async function summarizeFragranceReviews(input: {
  name: string;
  brand: string;
  reviews: RawReview[];
}): Promise<ReviewSummaryResult> {
  const name = input.name?.trim() || "";
  const brand = input.brand?.trim() || "";
  const normalized = normalizeReviews(Array.isArray(input.reviews) ? input.reviews : []);

  if (normalized.length === 0) return { comments: [], cached: false };

  const lookupKey = makeLookupKey(brand || "unknown", name || "unknown");
  const sourceHash = hashReviews(normalized);

  try {
    const rows = await db
      .select()
      .from(fragranceReviewSummariesTable)
      .where(eq(fragranceReviewSummariesTable.lookupKey, lookupKey))
      .limit(1);
    const row = rows[0];
    if (row && row.sourceHash === sourceHash && Array.isArray(row.comments)) {
      const validThemes = ["performance", "season", "vibe", "general"];
      const comments = (row.comments as unknown[])
        .map((c): SummarizedComment | null => {
          if (typeof c === "string") {
            return { text: c, theme: "general" };
          }
          if (c && typeof c === "object" && "text" in c && typeof (c as any).text === "string") {
            const rawTheme = (c as any).theme;
            const themeVal = typeof rawTheme === "string" && validThemes.includes(rawTheme.toLowerCase())
              ? (rawTheme.toLowerCase() as SummarizedComment["theme"])
              : "general";
            return { text: (c as any).text, theme: themeVal };
          }
          return null;
        })
        .filter((c): c is SummarizedComment => c !== null);
      if (comments.length > 0) return { comments, cached: true };
    }
  } catch {
    // Table missing or unreachable.
  }

  const fragranceName = [brand, name].filter(Boolean).join(" ") || "this fragrance";
  const comments = await generateWithGemini(fragranceName, normalized);

  if (comments.length === 0) return { comments: [], cached: false };

  try {
    await db
      .insert(fragranceReviewSummariesTable)
      .values({ lookupKey, comments, sourceHash })
      .onConflictDoUpdate({
        target: fragranceReviewSummariesTable.lookupKey,
        set: { comments, sourceHash, updatedAt: new Date() },
      });
  } catch {
    // Persistence failure is non-fatal.
  }

  return { comments, cached: false };
}

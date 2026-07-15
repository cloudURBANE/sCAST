import { ScentFactProfileSchema } from "./schema";
import type { ScentFactProfile, ScentSource } from "./types";

const LLM_TIMEOUT_MS = 20_000;

function normalizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  return [
    ...new Set(
      input
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .map((v) => v.replace(/\s+/g, " "))
        .filter(Boolean),
    ),
  ];
}

function cleanJson(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function prompt(fragranceName: string, sources: ScentSource[]): string {
  const sourceText = sources
    .map((s, i) =>
      [
        `SOURCE ${i + 1}`,
        `URL: ${s.url}`,
        `DOMAIN: ${s.domain}`,
        s.text.slice(0, 16_000),
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  return `
You are extracting factual fragrance note data.

Fragrance:
${fragranceName}

Rules:
- Use only the source text.
- Do not invent notes.
- If a note is not clearly present in source text, do not include it.
- Prefer notes repeated across multiple sources.
- If only one source exists, extract only clearly stated notes.
- top_notes = opening/top notes only.
- heart_notes = middle/heart notes only.
- base_notes = drydown/base notes only.
- accords = listed main accords only if present.
- Return raw JSON only.

JSON:
{
  "brand": "string",
  "name": "string",
  "top_notes": ["string"],
  "heart_notes": ["string"],
  "base_notes": ["string"],
  "accords": ["string"],
  "confidence_score": 0.0,
  "source_urls": ["https://example.com"]
}

Sources:
${sourceText}
`;
}

function openAiJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "brand",
      "name",
      "top_notes",
      "heart_notes",
      "base_notes",
      "accords",
      "confidence_score",
      "source_urls",
    ],
    properties: {
      brand: { type: "string" },
      name: { type: "string" },
      top_notes: { type: "array", items: { type: "string" } },
      heart_notes: { type: "array", items: { type: "string" } },
      base_notes: { type: "array", items: { type: "string" } },
      accords: { type: "array", items: { type: "string" } },
      confidence_score: { type: "number", minimum: 0, maximum: 1 },
      source_urls: { type: "array", items: { type: "string" } },
    },
  };
}

function extractOpenAiText(data: any): string | null {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  const firstOutput = Array.isArray(data?.output) ? data.output[0] : null;
  const content = Array.isArray(firstOutput?.content) ? firstOutput.content[0] : null;
  const text = content?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

async function extractWithOpenAI(
  fragranceName: string,
  sources: ScentSource[],
): Promise<unknown> {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt(fragranceName, sources),
      temperature: 0,
      text: {
        format: {
          type: "json_schema",
          name: "scent_fact_profile",
          strict: true,
          schema: openAiJsonSchema(),
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI extraction failed: ${res.status} ${await res.text()}`);
  }

  const data: any = await res.json();
  const text = extractOpenAiText(data);
  if (!text) throw new Error("OpenAI returned empty output.");
  return JSON.parse(cleanJson(text));
}

async function extractWithGemini(
  fragranceName: string,
  sources: ScentSource[],
): Promise<unknown> {
  if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  // Key in a header, not the URL, so it can never leak through URL logging.
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt(fragranceName, sources) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini extraction failed: ${res.status} ${await res.text()}`);
  }

  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Gemini returned empty output.");
  }
  return JSON.parse(cleanJson(text));
}

export async function extractScentFacts(
  fragranceName: string,
  sources: ScentSource[],
): Promise<ScentFactProfile> {
  if (!sources.length) throw new Error("No readable sources.");
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error("Missing LLM API key. Set OPENAI_API_KEY or GEMINI_API_KEY.");
  }

  const raw = process.env.OPENAI_API_KEY
    ? await extractWithOpenAI(fragranceName, sources)
    : await extractWithGemini(fragranceName, sources);

  const parsed = ScentFactProfileSchema.parse(raw);

  return {
    brand: parsed.brand || "",
    name: parsed.name || fragranceName,
    top_notes: normalizeList(parsed.top_notes),
    heart_notes: normalizeList(parsed.heart_notes),
    base_notes: normalizeList(parsed.base_notes),
    accords: normalizeList(parsed.accords),
    confidence_score: Math.max(0, Math.min(1, parsed.confidence_score)),
    source_urls: sources.map((s) => s.url),
  };
}

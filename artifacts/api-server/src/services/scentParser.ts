import type { FragranceData } from "./datasetLoader";

export type Concentration = "Parfum" | "Extrait" | "Eau de Parfum" | "Eau de Toilette" | "Eau de Cologne" | "Body Spray" | "Unknown";

export interface PyramidNotes {
  top: string[];
  heart: string[];
  base: string[];
}

export interface ParsedFragrance {
  notes: string[];
  pyramidNotes: PyramidNotes;
  family: string;
  description: string;
  perfumer: string;
  concentration: Concentration;
  accords: string[];
}

export const CONCENTRATION_PATTERNS: Array<{ pattern: RegExp; value: Concentration }> = [
  { pattern: /\b(extrait|extract|pure parfum)\b/i, value: "Extrait" },
  { pattern: /\b(e\.?d\.?p\.?|eau\s+de\s+parfum)\b/i, value: "Eau de Parfum" },
  { pattern: /\b(e\.?d\.?t\.?|eau\s+de\s+toilette)\b/i, value: "Eau de Toilette" },
  { pattern: /\b(e\.?d\.?c\.?|eau\s+de\s+cologne)\b/i, value: "Eau de Cologne" },
  { pattern: /\bbody\s+spray\b/i, value: "Body Spray" },
  { pattern: /\bparfum\b/i, value: "Parfum" },
];

const ACCORD_KEYWORDS = [
  "citrus", "floral", "woody", "oriental", "fresh", "spicy", "gourmand",
  "aquatic", "marine", "green", "powdery", "smoky", "resinous", "balsamic",
  "aromatic", "earthy", "leathery", "animalic", "mossy", "chypre", "fougere",
  "amber", "musk", "warm", "sweet", "dry", "creamy", "herbal", "mineral",
  "salty", "metallic", "fruity", "tropical", "boozy", "tobacco", "incense",
];

const PERFUMER_PATTERNS = [
  /(?:created?\s+by|perfum(?:ed|er)\s+by|(?:composed?|crafted?)\s+by|nose[:\s]+|by\s+perfumer)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:created?|perfumed?|composed?|crafted?)\s+(?:it|this)/i,
];

function detectConcentration(name: string, description: string): Concentration {
  const combined = `${name} ${description}`;
  for (const { pattern, value } of CONCENTRATION_PATTERNS) {
    if (pattern.test(combined)) return value;
  }
  return "Unknown";
}

function extractAccords(description: string, notes: string[]): string[] {
  const text = `${description} ${notes.join(" ")}`.toLowerCase();
  const found = ACCORD_KEYWORDS.filter(kw => text.includes(kw));
  const unique = Array.from(new Set(found));
  return unique.slice(0, 8);
}

function extractPerfumer(description: string, passedPerfumer?: string): string {
  if (passedPerfumer) return passedPerfumer;
  for (const pattern of PERFUMER_PATTERNS) {
    const match = description.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function normalizePyramid(pyramid?: FragranceData["pyramid"]): PyramidNotes {
  return {
    top: pyramid?.top ?? [],
    heart: pyramid?.heart ?? [],
    base: pyramid?.base ?? [],
  };
}

export function parseFragrance(data: FragranceData | undefined): ParsedFragrance | null {
  if (!data) return null;

  const notes = (data.notes ?? []).map(n => n.toLowerCase());
  const pyramidNotes = normalizePyramid(data.pyramid);
  const description = (data.description ?? "").toLowerCase();
  const family = data.family ?? "unknown";
  const name = data.name ?? "";

  const concentration = detectConcentration(name, description);
  const accords = extractAccords(description, notes);
  const perfumer = extractPerfumer(data.description ?? "", data.perfumer);

  return {
    notes,
    pyramidNotes: {
      top: pyramidNotes.top.map(n => n.toLowerCase()),
      heart: pyramidNotes.heart.map(n => n.toLowerCase()),
      base: pyramidNotes.base.map(n => n.toLowerCase()),
    },
    family,
    description,
    perfumer,
    concentration,
    accords,
  };
}

import type { Concentration } from "./scentParser.ts";
import { CONCENTRATION_PATTERNS } from "./scentParser.ts";

// Top-confidence entries mirrored from search_engine/concentration_grabber.py BRAND_PRIORS
const BRAND_PRIORS: Record<string, Concentration> = {
  "amouage":                  "Eau de Parfum",
  "xerjoff":                  "Parfum",
  "roja":                     "Parfum",
  "roja dove":                "Parfum",
  "clive christian":          "Parfum",
  "nishane":                  "Extrait",
  "maison francis kurkdjian": "Eau de Parfum",
  "francis kurkdjian":        "Eau de Parfum",
  "mfk":                      "Eau de Parfum",
  "parfums de marly":         "Eau de Parfum",
  "initio":                   "Eau de Parfum",
  "kilian":                   "Eau de Parfum",
  "by kilian":                "Eau de Parfum",
  "memo paris":               "Eau de Parfum",
  "frederic malle":           "Eau de Parfum",
  "le labo":                  "Eau de Parfum",
  "diptyque":                 "Eau de Parfum",
  "byredo":                   "Eau de Parfum",
  "creed":                    "Eau de Parfum",
  "tom ford private blend":   "Eau de Parfum",
  "mancera":                  "Eau de Parfum",
  "montale":                  "Eau de Parfum",
  "jo malone":                "Eau de Cologne",
};

export function resolveConcentrationFast(
  name: string,
  brand: string,
  description: string,
): { concentration: Concentration; confidence: number } | null {
  // Rule 1 — explicit in name or description (mirrors _explicit_intent)
  const combined = `${name} ${description}`;
  for (const { pattern, value } of CONCENTRATION_PATTERNS) {
    if (pattern.test(combined)) return { concentration: value, confidence: 95 };
  }

  // Rule 2 — brand prior (mirrors _brand_prior)
  const brandKey = brand.toLowerCase().trim();
  const prior = BRAND_PRIORS[brandKey];
  if (prior) return { concentration: prior, confidence: 70 };

  return null;
}

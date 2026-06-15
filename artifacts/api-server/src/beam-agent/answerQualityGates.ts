/**
 * Beam Agent — deterministic answer quality gates (brief §08.1, §01.3, §08.2).
 *
 * The cost-optimized stack drops the separate verification LLM and moves trust
 * into deterministic checks (brief §00.2). This module is that replacement: a
 * pure, fast pass over the final answer that blocks the specific unsupported
 * claims the brief forbids — inventing prices, availability/stock, or review
 * scores without fresh external evidence — plus a prompt-injection-leak guard and
 * a length budget.
 *
 * It is intentionally SOUND (designed to avoid false positives on a normal,
 * grounded recommendation): fragrance-name grounding is already enforced upstream
 * mechanically by the synthesis allowlist (beamAgentLoop.ts groundingAllowlistClause),
 * so the gates here cover the external-fact surface that allowlist does not.
 */
export type QualityGateInput = {
  /**
   * True when the run actually gathered a fresh external fact this turn (the
   * research lane returned a real fact, not a "note"). When false, any price /
   * availability / review claim in the answer is unsupported and is rejected.
   */
  hadExternalEvidence: boolean;
  /** Max answer length in characters (brief §08.1 response_under_token_budget). */
  maxChars?: number;
};

export type QualityGateResult = {
  passed: boolean;
  violations: string[];
};

/** ~4k chars ≈ the synthesis token budget; generous so premium answers don't trip it. */
const DEFAULT_MAX_CHARS = 4000;

/** A price figure: a `$`-prefixed number, or a number followed by a currency word. */
const PRICE_PATTERN =
  /(?:\$\s?\d|\bUSD\s?\d|\b\d{1,4}(?:[.,]\d{2})?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b)/i;

/** Availability / stock / discount claims that require a fresh source. */
const AVAILABILITY_PATTERN =
  /\b(?:in stock|out of stock|back in stock|sold out|currently available|available (?:now|at|from|online)|on sale|ships? (?:free|today|tomorrow)|discontinued|reformulated)\b|\b\d{1,3}%\s?off\b/i;

/** Numeric review-score / rating claims that require a fresh source. */
const REVIEW_PATTERN =
  /\b\d(?:\.\d)?\s?(?:\/|out of|of)\s?5\b|\b\d(?:\.\d)?\s?stars?\b|\b\d{1,3}%\s?(?:positive|recommend)/i;

/** Prompt-injection / instruction text leaking out of untrusted content into the reply. */
const LEAKED_INSTRUCTION_PATTERN =
  /\b(?:ignore (?:all|any|the|previous|above) (?:instructions?|prompts?)|disregard (?:all|any|the|previous|above)|you are now (?:a|an)\b|system prompt)\b|<\/?(?:system|instructions?)>|^\s*(?:system|assistant)\s*:/im;

/**
 * Evaluate the final answer. Returns the list of violated gate names (empty when
 * the answer passes). Pure; never throws.
 */
export function runAnswerQualityGates(answerText: string, input: QualityGateInput): QualityGateResult {
  const text = typeof answerText === "string" ? answerText : "";
  const maxChars = Number.isFinite(input.maxChars) ? (input.maxChars as number) : DEFAULT_MAX_CHARS;
  const violations: string[] = [];

  if (!input.hadExternalEvidence) {
    if (PRICE_PATTERN.test(text)) violations.push("price_without_evidence");
    if (AVAILABILITY_PATTERN.test(text)) violations.push("availability_without_evidence");
    if (REVIEW_PATTERN.test(text)) violations.push("review_claim_without_evidence");
  }
  if (LEAKED_INSTRUCTION_PATTERN.test(text)) violations.push("leaked_external_instruction");
  if (text.length > maxChars) violations.push("over_length");

  return { passed: violations.length === 0, violations };
}

/**
 * A short instruction appended to a constrained re-synthesis when gates fail
 * (brief §08.1 if_fail → "regenerate once with error feedback"). Maps each gate
 * to a concrete fix the model can act on.
 */
export function repairInstructionFor(violations: string[]): string {
  const fixes: string[] = [];
  if (violations.includes("price_without_evidence"))
    fixes.push("Do NOT state any price — you have no fresh price evidence; say the price needs confirmation.");
  if (violations.includes("availability_without_evidence"))
    fixes.push("Do NOT claim stock/availability/discontinued status — you have no fresh source for it.");
  if (violations.includes("review_claim_without_evidence"))
    fixes.push("Do NOT cite ratings or review scores — you have no fresh source for them.");
  if (violations.includes("leaked_external_instruction"))
    fixes.push("Remove any instruction-like text; answer only as the concierge.");
  if (violations.includes("over_length")) fixes.push("Be more concise.");
  return (
    "Your draft broke an answer rule. Rewrite it for the user, fixing: " +
    fixes.join(" ") +
    " Keep the grounded recommendation; only remove the unsupported claim."
  );
}

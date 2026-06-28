// WS-11: add-route body validation for POST /scent-profile and POST
// /search-scent. No generated Zod schema exists for these bodies (the OpenAPI
// spec doesn't model them), so we validate with small inline guards. These only
// reject malformed shapes; valid inputs pass through unchanged. Kept in its own
// module (no router/service imports) so it is cheaply unit-testable.

export type ScentBodyValidationResult =
  | { ok: true }
  | { ok: false; error: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Validates the POST /scent-profile body shape BEFORE buildProfile is called.
// Mirrors the casted shape the handler relies on; a violation yields a 400 with
// a clear message instead of letting a bad shape reach parseFragrance and 500.
export function validateScentProfileBody(body: unknown): ScentBodyValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return { ok: false, error: "Fragrance name is required" };
  }

  if (b.notes !== undefined && !isStringArray(b.notes)) {
    return { ok: false, error: "notes must be an array of strings" };
  }

  if (b.pyramid !== undefined) {
    if (typeof b.pyramid !== "object" || b.pyramid === null || Array.isArray(b.pyramid)) {
      return { ok: false, error: "pyramid must be an object" };
    }
    const pyramid = b.pyramid as Record<string, unknown>;
    for (const tier of ["top", "heart", "base"] as const) {
      if (pyramid[tier] !== undefined && !isStringArray(pyramid[tier])) {
        return { ok: false, error: `pyramid.${tier} must be an array of strings` };
      }
    }
  }

  for (const field of ["family", "description", "imageUrl", "perfumer", "brand", "concentrationHint"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
  }

  return { ok: true };
}

// Validates the POST /search-scent body shape.
export function validateSearchScentBody(body: unknown): ScentBodyValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.query !== "string" || b.query.trim().length === 0) {
    return { ok: false, error: "Query is required" };
  }

  if (b.concentrationHint !== undefined && typeof b.concentrationHint !== "string") {
    return { ok: false, error: "concentrationHint must be a string" };
  }

  return { ok: true };
}

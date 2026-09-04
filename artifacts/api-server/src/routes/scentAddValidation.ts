// WS-11: add-route body validation for POST /scent-profile and POST
// /search-scent. No generated Zod schema exists for these bodies (the OpenAPI
// spec doesn't model them), so we validate with small inline guards. These only
// reject malformed shapes; valid inputs pass through unchanged. Kept in its own
// module (no router/service imports) so it is cheaply unit-testable.

export const MAX_SEARCH_QUERY_LENGTH = 180;
export const MAX_NAME_LENGTH = 200;
export const MAX_BRAND_LENGTH = 120;
export const MAX_FAMILY_LENGTH = 120;
export const MAX_PERFUMER_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_IMAGE_URL_LENGTH = 2048;
export const MAX_CONCENTRATION_HINT_LENGTH = 50;
export const MAX_NOTE_LENGTH = 100;

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

  if (b.name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Fragrance name must not exceed ${MAX_NAME_LENGTH} characters` };
  }

  if (b.notes !== undefined) {
    if (!isStringArray(b.notes)) {
      return { ok: false, error: "notes must be an array of strings" };
    }
    for (const note of b.notes) {
      if (note.length > MAX_NOTE_LENGTH) {
        return { ok: false, error: `note must not exceed ${MAX_NOTE_LENGTH} characters` };
      }
    }
  }

  if (b.pyramid !== undefined) {
    if (typeof b.pyramid !== "object" || b.pyramid === null || Array.isArray(b.pyramid)) {
      return { ok: false, error: "pyramid must be an object" };
    }
    const pyramid = b.pyramid as Record<string, unknown>;
    for (const tier of ["top", "heart", "base"] as const) {
      if (pyramid[tier] !== undefined) {
        if (!isStringArray(pyramid[tier])) {
          return { ok: false, error: `pyramid.${tier} must be an array of strings` };
        }
        for (const note of pyramid[tier] as string[]) {
          if (note.length > MAX_NOTE_LENGTH) {
            return { ok: false, error: `pyramid.${tier} note must not exceed ${MAX_NOTE_LENGTH} characters` };
          }
        }
      }
    }
  }

  const fieldLimits: Record<string, number> = {
    brand: MAX_BRAND_LENGTH,
    family: MAX_FAMILY_LENGTH,
    description: MAX_DESCRIPTION_LENGTH,
    imageUrl: MAX_IMAGE_URL_LENGTH,
    perfumer: MAX_PERFUMER_LENGTH,
    concentrationHint: MAX_CONCENTRATION_HINT_LENGTH,
  };

  for (const [field, maxLen] of Object.entries(fieldLimits)) {
    if (b[field] !== undefined) {
      if (typeof b[field] !== "string") {
        return { ok: false, error: `${field} must be a string` };
      }
      if ((b[field] as string).length > maxLen) {
        return { ok: false, error: `${field} must not exceed ${maxLen} characters` };
      }
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

  if (typeof b.query !== "string") {
    return { ok: false, error: "Query is required" };
  }

  const query = b.query.replace(/\0/g, "");
  b.query = query;

  if (query.trim().length === 0) {
    return { ok: false, error: "Query is required" };
  }

  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return { ok: false, error: `Query must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters` };
  }

  if (b.concentrationHint !== undefined && typeof b.concentrationHint !== "string") {
    return { ok: false, error: "concentrationHint must be a string" };
  }

  return { ok: true };
}

const DATA_IMAGE_PREFIX = /^data:image\//i;

export function isBase64ImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && DATA_IMAGE_PREFIX.test(value.trim());
}

export function assertNoPersistedBase64Image(value: unknown, fieldName: string): void {
  if (isBase64ImageDataUrl(value)) {
    throw new Error(`Refusing to persist base64 image data in database field: ${fieldName}`);
  }

  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPersistedBase64Image(item, `${fieldName}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertNoPersistedBase64Image(child, `${fieldName}.${key}`);
  }
}

export function stripBase64ImageDataUrls<T>(value: T): T {
  if (isBase64ImageDataUrl(value)) return "" as T;
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => stripBase64ImageDataUrls(item)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = stripBase64ImageDataUrls(child);
  }
  return out as T;
}

export function safeImageUrlForResponse(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || isBase64ImageDataUrl(trimmed)) return "";
  return trimmed;
}

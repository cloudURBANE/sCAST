import { readFile } from "node:fs/promises";
import path from "node:path";

const DATA_IMAGE_PREFIX = /^data:image\//i;
const LOCAL_STORAGE_ROOT = path.resolve(
  process.env.IMAGE_LOCAL_STORAGE_DIR || path.join(process.cwd(), ".image-cache"),
);

export type ImageReferenceDiagnostic = {
  kind: "missing" | "empty" | "data" | "local-object" | "local-object-missing" | "http" | "other";
  usable: boolean;
  length: number;
  storagePath?: string;
};

function isBase64ImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && DATA_IMAGE_PREFIX.test(value.trim());
}

function safeImageUrlForResponse(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || isBase64ImageDataUrl(trimmed)) return "";
  return trimmed;
}

function envFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isLocalImageObjectUrlPersistable(): boolean {
  return envFlagEnabled(process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE) && process.env.NODE_ENV !== "production";
}

function assertSafeStorageKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("..")) {
    throw new Error("Unsafe image storage key");
  }
  if (!/^images\/processed\/[a-z0-9/_-]+\.(webp|png|jpg|jpeg)$/i.test(key)) {
    throw new Error("Image storage key must live under images/processed");
  }
}

function storagePathFromLocalImageObjectUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/api/image-objects/")) return null;
  try {
    const encodedPath = trimmed.slice("/api/image-objects/".length).split(/[?#]/, 1)[0];
    const storagePath = encodedPath.split("/").map(decodeURIComponent).join("/");
    assertSafeStorageKey(storagePath);
    return storagePath;
  } catch {
    return null;
  }
}

async function localImageObjectExists(storagePath: string): Promise<boolean> {
  try {
    assertSafeStorageKey(storagePath);
    const fullPath = path.resolve(LOCAL_STORAGE_ROOT, storagePath);
    if (!fullPath.startsWith(`${LOCAL_STORAGE_ROOT}${path.sep}`)) return false;
    await readFile(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function usableImageUrlForResponse(value: unknown): Promise<string | null> {
  const url = safeImageUrlForResponse(value);
  if (!url) return null;

  const localStoragePath = storagePathFromLocalImageObjectUrl(url);
  if (localStoragePath) {
    if (!(await localImageObjectExists(localStoragePath))) return null;
  }

  return url;
}

export function savedImageUrlForResponse(value: unknown): string | null {
  const url = safeImageUrlForResponse(value);
  return url || null;
}

export async function persistableImageReference(value: unknown): Promise<string | null> {
  const url = await usableImageUrlForResponse(value);
  if (!url) return null;
  if (url.startsWith("/api/image-objects/")) {
    return isLocalImageObjectUrlPersistable() ? url : null;
  }
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

export async function imageReferenceDiagnostic(value: unknown): Promise<ImageReferenceDiagnostic> {
  if (typeof value !== "string") {
    return { kind: "missing", usable: false, length: 0 };
  }

  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty", usable: false, length: value.length };
  if (isBase64ImageDataUrl(trimmed)) return { kind: "data", usable: false, length: value.length };

  const localStoragePath = storagePathFromLocalImageObjectUrl(trimmed);
  if (localStoragePath) {
    const usable = await localImageObjectExists(localStoragePath);
    return {
      kind: usable ? "local-object" : "local-object-missing",
      usable,
      length: value.length,
      storagePath: localStoragePath,
    };
  }

  if (/^https?:\/\//i.test(trimmed)) return { kind: "http", usable: true, length: value.length };
  return { kind: "other", usable: true, length: value.length };
}

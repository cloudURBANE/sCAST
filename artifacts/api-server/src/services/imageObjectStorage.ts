import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export type ImageStorageProvider = "firebase" | "supabase" | "local";

export type UploadProcessedImageInput = {
  buffer: Buffer;
  contentType: string;
  key: string;
  cacheControl?: string;
};

export type UploadedImageObject = {
  publicUrl?: string;
  signedUrl?: string;
  storagePath: string;
  provider: ImageStorageProvider;
  sizeBytes: number;
};

export interface ImageObjectStorage {
  uploadProcessedImage(input: UploadProcessedImageInput): Promise<UploadedImageObject>;
  getPublicUrl(storagePath: string): Promise<string>;
  deleteObject?(storagePath: string): Promise<void>;
}

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STORAGE_NOT_CONFIGURED_MESSAGE =
  "Image object storage is not configured. Set FIREBASE_STORAGE_BUCKET or SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_IMAGE_BUCKET. For local development only, set IMAGE_ALLOW_LOCAL_OBJECT_STORAGE=true.";
const LOCAL_STORAGE_ROOT = path.resolve(
  process.env.IMAGE_LOCAL_STORAGE_DIR || path.join(process.cwd(), ".image-cache"),
);
const runtimeRequire =
  typeof globalThis.require === "function" ? globalThis.require : createRequire(import.meta.url);

export class ImageObjectStorageConfigurationError extends Error {
  constructor() {
    super(STORAGE_NOT_CONFIGURED_MESSAGE);
    this.name = "ImageObjectStorageConfigurationError";
  }
}

function envFlagEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function encodeStoragePath(storagePath: string): string {
  return storagePath.split("/").map(encodeURIComponent).join("/");
}

export function storagePathFromLocalImageObjectUrl(value: string): string | null {
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

function assertSafeStorageKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("..")) {
    throw new Error("Unsafe image storage key");
  }
  if (!/^images\/processed\/[a-z0-9/_-]+\.(webp|png|jpg|jpeg)$/i.test(key)) {
    throw new Error("Image storage key must live under images/processed");
  }
}

class LocalImageObjectStorage implements ImageObjectStorage {
  readonly provider = "local" as const;

  async uploadProcessedImage(input: UploadProcessedImageInput): Promise<UploadedImageObject> {
    assertSafeStorageKey(input.key);
    const fullPath = path.resolve(LOCAL_STORAGE_ROOT, input.key);
    if (!fullPath.startsWith(`${LOCAL_STORAGE_ROOT}${path.sep}`)) {
      throw new Error("Unsafe local image storage path");
    }
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.buffer);
    return {
      publicUrl: await this.getPublicUrl(input.key),
      storagePath: input.key,
      provider: this.provider,
      sizeBytes: input.buffer.length,
    };
  }

  async getPublicUrl(storagePath: string): Promise<string> {
    assertSafeStorageKey(storagePath);
    return `/api/image-objects/${encodeStoragePath(storagePath)}`;
  }

  async deleteObject(storagePath: string): Promise<void> {
    assertSafeStorageKey(storagePath);
    const fullPath = path.resolve(LOCAL_STORAGE_ROOT, storagePath);
    if (!fullPath.startsWith(`${LOCAL_STORAGE_ROOT}${path.sep}`)) return;
    await unlink(fullPath).catch(() => {});
  }
}

class FirebaseImageObjectStorage implements ImageObjectStorage {
  readonly provider = "firebase" as const;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
  }

  private getBucket(): any {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Storage requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY");
    }

    const admin = runtimeRequire("firebase-admin");
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, "\n"),
          }),
        });
    return admin.storage(app).bucket(this.bucketName);
  }

  async uploadProcessedImage(input: UploadProcessedImageInput): Promise<UploadedImageObject> {
    assertSafeStorageKey(input.key);
    const bucket = this.getBucket();
    const token = randomUUID();
    const file = bucket.file(input.key);
    await file.save(input.buffer, {
      resumable: false,
      contentType: input.contentType,
      metadata: {
        cacheControl: input.cacheControl ?? DEFAULT_CACHE_CONTROL,
        contentType: input.contentType,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    return {
      publicUrl: await this.getPublicUrlWithToken(input.key, token),
      storagePath: input.key,
      provider: this.provider,
      sizeBytes: input.buffer.length,
    };
  }

  async getPublicUrl(storagePath: string): Promise<string> {
    assertSafeStorageKey(storagePath);
    const base = process.env.FIREBASE_STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, "");
    if (base) return `${base}/${encodeStoragePath(storagePath)}`;

    return `https://firebasestorage.googleapis.com/v0/b/${this.bucketName}/o/${encodeURIComponent(storagePath)}?alt=media`;
  }

  private async getPublicUrlWithToken(storagePath: string, token: string): Promise<string> {
    const base = process.env.FIREBASE_STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, "");
    if (base) return `${base}/${encodeStoragePath(storagePath)}`;

    return `https://firebasestorage.googleapis.com/v0/b/${this.bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  }

  async deleteObject(storagePath: string): Promise<void> {
    assertSafeStorageKey(storagePath);
    await this.getBucket().file(storagePath).delete({ ignoreNotFound: true });
  }
}

class SupabaseImageObjectStorage implements ImageObjectStorage {
  readonly provider = "supabase" as const;
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    bucket: string,
  ) {
    this.supabaseUrl = supabaseUrl;
    this.serviceRoleKey = serviceRoleKey;
    this.bucket = bucket;
  }

  async uploadProcessedImage(input: UploadProcessedImageInput): Promise<UploadedImageObject> {
    assertSafeStorageKey(input.key);
    const endpoint = `${this.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${this.bucket}/${input.key}`;
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${this.serviceRoleKey}`,
        "apikey": this.serviceRoleKey,
        "Content-Type": input.contentType,
        "Cache-Control": input.cacheControl ?? DEFAULT_CACHE_CONTROL,
        "x-upsert": "true",
      },
      body: input.buffer,
    });

    if (!response.ok) {
      throw new Error(`Supabase Storage upload failed with HTTP ${response.status}`);
    }

    return {
      publicUrl: await this.getPublicUrl(input.key),
      storagePath: input.key,
      provider: this.provider,
      sizeBytes: input.buffer.length,
    };
  }

  async getPublicUrl(storagePath: string): Promise<string> {
    assertSafeStorageKey(storagePath);
    const base = process.env.SUPABASE_IMAGE_PUBLIC_URL_BASE?.replace(/\/+$/, "");
    if (base) return `${base}/${encodeStoragePath(storagePath)}`;
    return `${this.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${this.bucket}/${encodeStoragePath(storagePath)}`;
  }

  async deleteObject(storagePath: string): Promise<void> {
    assertSafeStorageKey(storagePath);
    const endpoint = `${this.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${this.bucket}/${storagePath}`;
    await fetch(endpoint, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${this.serviceRoleKey}`,
        "apikey": this.serviceRoleKey,
      },
    }).catch(() => {});
  }
}

let warnedDerivedFirebaseBucket = false;

/**
 * Resolve the Firebase Storage bucket name.
 *
 * Prefer the explicit `FIREBASE_STORAGE_BUCKET`, but when it is unset and the
 * Firebase *credentials* (project id, client email, private key) ARE present,
 * derive the conventional default bucket from the project id. Without this, a
 * deploy that configured the Firebase service account but forgot the one bucket
 * var falls all the way through `getImageObjectStorage()` to
 * `ImageObjectStorageConfigurationError`, which the deferred image path swallows
 * — so every fragrance silently renders "No image" even though storage is one
 * variable away from working. That was the production failure mode.
 *
 * Newer Firebase projects default to `<projectId>.firebasestorage.app`; set
 * `FIREBASE_STORAGE_BUCKET` explicitly to override (e.g. a legacy
 * `<projectId>.appspot.com` bucket). The derived value is logged once so a wrong
 * guess is visible in logs instead of failing silently.
 */
function resolveFirebaseStorageBucket(): string | undefined {
  const explicit = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (explicit) return explicit;

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const hasFirebaseCredentials =
    !!projectId &&
    !!process.env.FIREBASE_CLIENT_EMAIL?.trim() &&
    !!process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!hasFirebaseCredentials) return undefined;

  const derived = `${projectId}.firebasestorage.app`;
  if (!warnedDerivedFirebaseBucket) {
    warnedDerivedFirebaseBucket = true;
    console.warn(
      `[imageObjectStorage] FIREBASE_STORAGE_BUCKET is not set; defaulting to "${derived}" ` +
        `derived from FIREBASE_PROJECT_ID. Set FIREBASE_STORAGE_BUCKET explicitly if your ` +
        `bucket differs (e.g. "${projectId}.appspot.com").`,
    );
  }
  return derived;
}

export function getImageObjectStorage(): ImageObjectStorage {
  // 1. An explicit Firebase bucket is an unambiguous operator choice — highest
  //    priority.
  const explicitFirebaseBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (explicitFirebaseBucket) return new FirebaseImageObjectStorage(explicitFirebaseBucket);

  // 2. Explicit Supabase Storage config. This MUST be checked before the derived
  //    Firebase bucket below. Production stores processed images in Supabase
  //    while ALSO setting FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY for the
  //    Firestore `bg_cache` (firebaseCache.ts). If we derived a Firebase Storage
  //    bucket from those cache credentials first, every upload would be routed to
  //    a `<projectId>.firebasestorage.app` bucket that production never
  //    provisioned — uploads fail (or land where the stored URL can't serve) and
  //    every tile renders "No image". Honoring an explicit Supabase store here
  //    keeps the documented contract (IMAGE_STORAGE_CACHE_PLAN.md): Firebase only
  //    wins when its bucket is explicitly set.
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const supabaseBucket = process.env.SUPABASE_IMAGE_BUCKET?.trim();
  if (supabaseUrl && supabaseKey && supabaseBucket) {
    return new SupabaseImageObjectStorage(supabaseUrl, supabaseKey, supabaseBucket);
  }

  // 3. Derived Firebase bucket: Firebase credentials are present but the bucket
  //    var was forgotten AND no Supabase store is configured. Rescue the deploy
  //    by guessing the conventional default bucket instead of throwing (the
  //    original "every fragrance silently renders No image" failure mode).
  const derivedFirebaseBucket = resolveFirebaseStorageBucket();
  if (derivedFirebaseBucket) return new FirebaseImageObjectStorage(derivedFirebaseBucket);

  if (isLocalImageObjectUrlPersistable()) {
    return new LocalImageObjectStorage();
  }

  throw new ImageObjectStorageConfigurationError();
}

export function isLocalImageObjectStorageEnabled(): boolean {
  return envFlagEnabled(process.env.IMAGE_ALLOW_LOCAL_OBJECT_STORAGE);
}

export function isLocalImageObjectUrlPersistable(): boolean {
  return isLocalImageObjectStorageEnabled() && process.env.NODE_ENV !== "production";
}

export function getLocalImageStorageRoot(): string {
  return LOCAL_STORAGE_ROOT;
}

export async function readLocalImageObject(storagePath: string): Promise<Buffer> {
  assertSafeStorageKey(storagePath);
  const fullPath = path.resolve(LOCAL_STORAGE_ROOT, storagePath);
  if (!fullPath.startsWith(`${LOCAL_STORAGE_ROOT}${path.sep}`)) {
    throw new Error("Unsafe local image storage path");
  }
  return readFile(fullPath);
}

export async function localImageObjectExists(storagePath: string): Promise<boolean> {
  try {
    await readLocalImageObject(storagePath);
    return true;
  } catch {
    return false;
  }
}

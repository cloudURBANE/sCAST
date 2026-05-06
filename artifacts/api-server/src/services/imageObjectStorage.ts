import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
const LOCAL_STORAGE_ROOT = path.resolve(
  process.env.IMAGE_LOCAL_STORAGE_DIR || path.join(process.cwd(), ".image-cache"),
);

function encodeStoragePath(storagePath: string): string {
  return storagePath.split("/").map(encodeURIComponent).join("/");
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

  constructor(private readonly bucketName: string) {}

  private getBucket(): any {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firebase Storage requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY");
    }

    const admin = globalThis.require("firebase-admin");
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

  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
  ) {}

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

export function getImageObjectStorage(): ImageObjectStorage {
  const firebaseBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (firebaseBucket) return new FirebaseImageObjectStorage(firebaseBucket);

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const supabaseBucket = process.env.SUPABASE_IMAGE_BUCKET?.trim();
  if (supabaseUrl && supabaseKey && supabaseBucket) {
    return new SupabaseImageObjectStorage(supabaseUrl, supabaseKey, supabaseBucket);
  }

  return new LocalImageObjectStorage();
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

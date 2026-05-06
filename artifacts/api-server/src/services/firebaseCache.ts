import { createHash } from "crypto";
import type { Firestore } from "firebase-admin/firestore";
import { safeImageUrlForResponse } from "./persistenceGuards";

let firestoreDb: Firestore | null = null;
let initAttempted = false;

// In-flight deduplication: prevents cache stampede when multiple users
// request the same uncached fragrance simultaneously. All concurrent callers
// share one Promise instead of each spawning their own background-removal API call.
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Build the bg_cache document key.
 *
 * Stays in lockstep with `makeLookupKey` in catalogService — both are derived
 * from `${trim().toLowerCase(brand)}::${trim().toLowerCase(name)}` so a
 * fragrance that resolves to one row in Postgres also resolves to one entry
 * in Firestore. The previous implementation also stripped diacritics and
 * punctuation, which collapsed legitimately distinct products onto the same
 * cache key (e.g. "L'Eau" vs "Leau") and let one fragrance's image leak
 * across to another (B5).
 */
function normalizeKey(brand: string, name: string): string {
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " "); // collapse internal whitespace only

  const normalized = `${normalize(brand)}::${normalize(name)}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function isValidImageReference(value: unknown): value is string {
  const url = safeImageUrlForResponse(value);
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("/api/image-objects/")
  );
}

function getDb(): Firestore | null {
  if (initAttempted) return firestoreDb;
  initAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.error("[firebaseCache] Missing env vars — cache disabled");
    return null;
  }

  try {
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
    firestoreDb = app.firestore();
    console.log("[firebaseCache] Firestore connected ✓");
    return firestoreDb;
  } catch (err) {
    console.error("[firebaseCache] init failed:", err);
    return null;
  }
}

async function readFromFirestore(
  db: Firestore,
  key: string,
): Promise<string | null> {
  try {
    const doc = await db.collection("bg_cache").doc(key).get();
    if (!doc.exists) return null;
    const data = doc.data();
    const value = data?.publicUrl ?? data?.imageUrl;
    return isValidImageReference(value) ? value : null;
  } catch (err) {
    console.error("[firebaseCache] read error:", err);
    return null;
  }
}

async function writeToFirestore(
  db: Firestore,
  key: string,
  brand: string,
  name: string,
  imageUrl: string,
): Promise<void> {
  try {
    if (!isValidImageReference(imageUrl)) return;
    await db.collection("bg_cache").doc(key).set({
      publicUrl: imageUrl,
      brand: brand.trim(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
    });
    console.log(`[firebaseCache] stored — ${brand} ${name}`);
  } catch (err) {
    console.error("[firebaseCache] write error:", err);
  }
}

/**
 * Check the cache by name+brand first. On miss, call fetchFn() exactly once
 * regardless of how many concurrent callers requested the same key, then
 * persist the result. Safe for many simultaneous users.
 */
export async function getOrCreateCachedImage(
  brand: string,
  name: string,
  fetchFn: () => Promise<string | null>,
): Promise<string | null> {
  const key = normalizeKey(brand, name);
  const db = getDb();

  // Fast path: already an in-flight request for this key — join it
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[firebaseCache] joining in-flight — ${brand} ${name}`);
    return existing;
  }

  const promise = (async (): Promise<string | null> => {
    try {
      // 1. Check Firestore (double-checked inside lock to handle races)
      if (db) {
        const cached = await readFromFirestore(db, key);
        if (cached) {
          console.log(`[firebaseCache] HIT — ${brand} ${name}`);
          return cached;
        }
      }

      // 2. Cache miss — run the caller's fetch (image search + background removal)
      const result = await fetchFn();

      // 3. Persist lightweight image references only. Base64 image payloads
      // are intentionally ignored by this legacy Firestore cache.
      if (result && isValidImageReference(result) && db) {
        // Fire-and-forget so callers are not blocked by the write
        writeToFirestore(db, key, brand, name, result).catch(() => {});
      }

      return result;
    } finally {
      // Always release the in-flight lock
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

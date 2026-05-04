import { createHash } from "crypto";
import type { Firestore } from "firebase-admin/firestore";

let firestoreDb: Firestore | null = null;
let initAttempted = false;

// In-flight deduplication: prevents cache stampede when multiple users
// request the same uncached fragrance simultaneously. All concurrent callers
// share one Promise instead of each spawning their own remove.bg API call.
const inFlight = new Map<string, Promise<string | null>>();

function normalizeKey(brand: string, name: string): string {
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")          // collapse multiple spaces
      .normalize("NFD")              // decompose accented chars
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .replace(/[^\w\s-]/g, "");    // strip punctuation

  const normalized = `${normalize(brand)}::${normalize(name)}`;
  return createHash("sha256").update(normalized).digest("hex");
}

function isValidDataUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("data:image/png;base64,") &&
    value.length > 100
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
    const value = data?.cleanImage;
    return isValidDataUri(value) ? value : null;
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
  cleanImage: string,
): Promise<void> {
  try {
    await db.collection("bg_cache").doc(key).set({
      cleanImage,
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

      // 2. Cache miss — run the caller's fetch (image search + remove.bg)
      const result = await fetchFn();

      // 3. Persist valid PNG results only
      if (result && isValidDataUri(result) && db) {
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

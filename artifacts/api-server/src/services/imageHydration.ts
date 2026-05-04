import { getCatalogEntry, searchCatalog } from "./catalogService";
import { getOrCreateCachedImage } from "./firebaseCache";

function hasImageUrl(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the most reliable image for a fragrance across shared stores:
 * 1) exact catalog key (Postgres), 2) fuzzy catalog lookup, 3) Firestore cache.
 */
export async function resolveSharedImageUrl(
  brand: string,
  name: string,
): Promise<string | null> {
  // #region agent log
  const dbg=(stage: string, payload: Record<string, unknown>)=>{fetch('http://127.0.0.1:7745/ingest/484c0150-587d-4568-9bd7-b30ce5dec585',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6001a3'},body:JSON.stringify({sessionId:'6001a3',hypothesisId:'B_image_resolve',location:`imageHydration.ts:${stage}`,message:'image resolve step',data:{inputBrand:brand,inputName:name,...payload},timestamp:Date.now()})}).catch(()=>{});};
  // #endregion
  try {
    const exact = await getCatalogEntry(brand, name);
    if (hasImageUrl(exact?.imageUrl)) {
      dbg('exact-hit',{returnedName:exact.product?.name??null,returnedBrand:exact.product?.brand??null,imageKind:exact.imageUrl.startsWith('data:')?'data':'http'});
      return exact.imageUrl;
    }
    dbg('exact-miss',{exactPresent:!!exact,exactHasImage:hasImageUrl(exact?.imageUrl)});
  } catch (err: any) {
    dbg('exact-error',{err:err?.message??String(err)});
  }

  try {
    const fuzzy = await searchCatalog(`${brand} ${name}`);
    if (hasImageUrl(fuzzy?.imageUrl)) {
      dbg('fuzzy-hit',{returnedName:fuzzy.product?.name??null,returnedBrand:fuzzy.product?.brand??null,nameDrift:(fuzzy.product?.name??'').toLowerCase()!==name.toLowerCase(),brandDrift:(fuzzy.product?.brand??'').toLowerCase()!==brand.toLowerCase(),imageKind:fuzzy.imageUrl.startsWith('data:')?'data':'http'});
      return fuzzy.imageUrl;
    }
    dbg('fuzzy-miss',{fuzzyPresent:!!fuzzy,fuzzyHasImage:hasImageUrl(fuzzy?.imageUrl)});
  } catch (err: any) {
    dbg('fuzzy-error',{err:err?.message??String(err)});
  }

  try {
    // Read-through from Firestore cache only; do not trigger new image generation here.
    const cached = await getOrCreateCachedImage(brand, name, async () => null);
    if (hasImageUrl(cached)) {
      dbg('firestore-hit',{imageKind:cached.startsWith('data:')?'data':'http'});
      return cached;
    }
    dbg('firestore-miss',{cachedPresent:!!cached});
  } catch (err: any) {
    dbg('firestore-error',{err:err?.message??String(err)});
  }

  dbg('all-miss',{});
  return null;
}

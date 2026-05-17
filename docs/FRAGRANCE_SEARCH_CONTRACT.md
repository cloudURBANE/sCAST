# Fragrance Search Frontend Contract

Verified against `artifacts/scent-cast/src/lib/fragranceApi.ts`,
`artifacts/scent-cast/src/components/FragranceCapture.tsx`, and
`artifacts/scent-cast/src/lib/fragranceApi.test.ts`.

## Scope

This note covers the actual `artifacts/scent-cast` frontend search and detail
selection behavior. In runtime code, `FragranceCapture` is the only frontend
component that calls `searchFragrances`; tests also call it directly.

## Response Shape

`searchFragrances` returns:

```ts
type FragranceSearchResponse = {
  query: string;
  results: FragranceSearchResult[];
  diagnostics?: FragranceSearchDiagnostics;
};
```

Search diagnostics are typed and preserved by the client. They are passed through
with a shallow object cast when parsing engine and app API responses.

```ts
function normalizeSearchDiagnostics(value: unknown): FragranceSearchDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FragranceSearchDiagnostics;
}
```

`FragranceCapture` only reads `searchData.results`; it does not read or render
`searchData.diagnostics`.

## Diagnostics Behavior

`fragrantica_unreachable` is present on the TypeScript diagnostics type, but the
frontend does not branch on it or show it in the UI.

`warning` is also present on the type, but it is not referenced for display,
logging, or branching in the search UI.

`fallback_source` is not shown to users. Its only behavioral use is in
supplemental search breadth detection:

```ts
function hasDegradedBreadth(diagnostics: FragranceSearchDiagnostics | undefined): boolean {
  if (!diagnostics || !("fallback_source" in diagnostics)) return false;
  return diagnostics.fallback_source !== null && diagnostics.fallback_source !== undefined;
}
```

Important contract detail: degraded breadth requires the `fallback_source` key to
exist and have a non-null value. If the backend sends only
`fragrantica_unreachable: true` and omits `fallback_source`, this check does not
treat breadth as degraded. Supplemental app search may still run for zero
results, or for short result lists where the query exactly matches a result
house.

## Supplemental Search

The frontend first searches the fragrance engine:

```ts
`${base}/api/fragrances/search?q=${encodeURIComponent(query)}`
```

It supplements with the app API when:

1. `diagnostics.fallback_source` exists and is non-null.
2. The engine returns zero normalized results.
3. The engine returns fewer than `SUPPLEMENTAL_SEARCH_MIN_RESULTS` results and
   the normalized query matches a returned house or brand.

Supplemental search uses the app endpoint:

```ts
appApiUrl(`/api/fragrances/search?q=${encodeURIComponent(query)}`)
```

When supplemental search is used, primary and supplemental results are merged
client-side. Supplemental results that still lack a resolved `house` or `brand`
after normalization are dropped before merge, because they cannot produce a
usable vault match row.

## Result Deduplication

`mergeSearchResults` deduplicates across primary and supplemental results with
`fragranceIdentityKey`.

The identity key is:

1. Normalized `house` or `brand`, plus normalized `name`, if either value exists.
2. Otherwise normalized `source_url` or `id`.

```ts
function fragranceIdentityKey(result: FragranceSearchResult): string {
  const house = normalizeForDedupe(result.house ?? result.brand);
  const name = normalizeForDedupe(result.name);
  if (house || name) return `${house}::${name}`;
  return normalizeForDedupe(result.source_url ?? result.id);
}
```

The match list UI itself uses `key={i}`, so React reconciliation is positional
and independent of the dedupe key.

## Query Handling

The first HTTP request uses the query string as entered, with only
`encodeURIComponent` applied. The search handler avoids empty searches with trim
checks, but `searchFragrances` itself does not lowercase, collapse whitespace, or
otherwise normalize the query before sending it.

Search cache keys are normalized separately:

```ts
function fragranceSearchCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}
```

That means differently cased or spaced queries can reuse a cached response, but
the first uncached request goes out with the original casing and spacing.

Successful non-supplemented search responses are cached in browser
`localStorage` under `scentcast.fragranceSearchCache.v3`. Empty responses are not
cached, and searches that used supplemental app search are not cached by this
client path.

## Match Confidence And Scores

This frontend does not use `query_score` or search match-confidence fields in the
fragrance search UI. Grep finds unrelated weather recommendation confidence
logic, but not search-result confidence rendering.

The numeric badge shown beside each match is only the one-based list index:

```tsx
String(i + 1).padStart(2, '0')
```

Extra fields from the server may still survive on each result through object
spreading, but they are not rendered as search confidence.

## Empty Name And House Handling

`normalizeFragranceSearchResult` derives `name` from the first non-empty value
among:

1. `name`
2. `fragrance_name`
3. `title`
4. `product_name`
5. the fallback query

If all supplied name fields are empty, the normalized result uses the trimmed
query as the name. `FragranceCapture` hardens this again with
`firstString(result.name) ?? targetQuery.trim()`.

`house` is derived from the first non-empty value among:

1. `house`
2. `brand`
3. `brand_name`
4. `designer`
5. less common aliases such as `house_name`, `designer_name`, `manufacturer`,
   `maker`, `company`, `perfume_house`, and `fragrance_house`
6. nested `product.brand` / `product.house` / `product.brand_name` /
   `product.designer`
7. a Fragrantica-style `source_url`
8. a structured `source:` / `catalog:` / `dataset:` id
9. an SRT opaque base64 id containing compact identity fields such as `b`

For SRT opaque ids, the client also treats compact `fg` then `bn` URL fields as
a last-resort `source_url` fallback when no explicit URL is present. Explicit
wire URL fields still win.

`FragranceCapture` then sets both `house` and `brand` to the first non-empty
`result.house` or `result.brand`. As a final guard, it filters out candidates
that still have no brand/house after normalization. The subtitle still contains
the defensive fallback `m.brand || 'House unavailable'`, but normalized search
matches should not reach that render path without a resolved house.

The current client intentionally recovers identity before this UI mapping. A
result with only an opaque SRT id, only a `source:` id, only a nested
`product.brand`, or only a Fragrantica-style URL should still render a house
when that identity can be inferred.

## Search Logs And Captures

No Sentry or equivalent telemetry package usage was found under
`artifacts/scent-cast/src`.

No code under `artifacts/scent-cast/src` logs search payloads, `searchData`, or
search result arrays.

One related `console.info` exists in `FragranceCapture`, but it is for details
requests without a Fragrantica source URL. It does not log search responses.

```ts
console.info('[FragranceCapture] /details request has no Fragrantica source URL', {
  selectedId: selected.id,
  selectedSourceUrl,
});
```

Caveat: `artifacts/scent-cast/middleware.js` logs failed proxied target URLs on
proxy fetch failure. If a proxied `/api/fragrances/search` request fails there,
the logged target URL can include the encoded search query string.

Caveat: search results can exist client-side in browser `localStorage` due to the
search cache described above. Tests are not the only possible result-shaped
examples at runtime.

## Detail Request Behavior

`getFragranceDetails` performs a single POST and throws on non-OK responses. It
does not retry with a different payload shape.

```ts
if (!res.ok) {
  throw new Error(await apiErrorMessage(res, `Fragrance detail fetch failed: ${res.status}`));
}
```

`FragranceCapture` builds the detail request from the selected match:

```ts
const detailsRequest: FragranceDetailRequestPayload =
  selectedOrigin === 'app' && detailSourceUrl
    ? { source_url: detailSourceUrl, origin: 'app' }
    : selectedOrigin === 'app' && selectedId
      ? { id: selectedId, origin: 'app' }
      : selectedId
    ? {
        id: selectedId,
        origin: 'srt',
      }
    : { source_url: detailSourceUrl as string, origin: 'app' };
```

For SRT selections in `FragranceCapture`, the payload is `{ id, origin: 'srt' }`.
Even if the selected search result has a `source_url`, that source URL is not
included in the SRT detail payload from this component. If that initial detail
fetch throws, `handleConfirm` surfaces the error message as a hard error.

Nuance: the lower-level `getFragranceDetails` client can send both `id` and
`source_url` to the SRT engine if a caller passes both. That behavior is covered
by `fragranceApi.test.ts`. The no-source-url statement applies to
`FragranceCapture`'s SRT selection path, not to the generic client function.

Inside the detail polling loop, a later failed refresh can return the existing
partial detail with a notice. That is not a retry using `source_url` because the
opaque id failed.

## Contract Takeaways

Pin the frontend search contract as:

1. `FragranceSearchResponse` is `{ query, results, diagnostics? }`.
2. `FragranceCapture` behavior is driven by `results`, not `diagnostics`.
3. `diagnostics.fallback_source` with key present and non-null triggers
   supplemental app search.
4. `fragrantica_unreachable` and `warning` are preserved but not rendered or used
   for search UI behavior.
5. Weak supplemental app/source results with no resolved house are filtered out
   before they can appear in the match list.
6. The first uncached search request uses the raw entered query on the wire.
7. Successful non-supplemented searches are cached in browser `localStorage` with
   normalized cache keys.
8. Search confidence fields such as `query_score` are not displayed; the visible
   number badge is the match index.
9. Missing names fall back to the query; search matches with unrecoverable houses
   are filtered out of `FragranceCapture`.
10. Search identity normalization recovers house/name from explicit fields,
   nested product data, source URLs, source/catalog/dataset ids, and SRT opaque
   ids before the match list renders.
11. `FragranceCapture` SRT details use an opaque id payload and do not bundle
   `source_url` for decode recovery.
12. The generic `getFragranceDetails` client can send `id` plus `source_url` when
    explicitly called that way.

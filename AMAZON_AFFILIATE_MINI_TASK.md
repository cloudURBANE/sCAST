# Codex Mini Task: Add Amazon Affiliate Fallback Safely

## Goal

Add Amazon affiliate support as a lightweight fallback provider.

Do not rebuild the full affiliate system.

Do not waste tokens.

Do not change unrelated CJ or Rakuten logic.

The app should try affiliate providers in this order:

```txt
1. Rakuten affiliate link if configured and product match exists
2. CJ affiliate link if configured and product match exists
3. Amazon affiliate link if configured and product match exists
4. Original Amazon product link if no affiliate provider is available
```

## Important Amazon Notes

Amazon affiliate linking requires an Amazon Associates tracking tag.

For Amazon Product Advertising API access, Amazon requires an approved Amazon Associates account, a Partner/Associate tag, and API credentials. Amazon's PA-API Scratchpad asks for Partner Tag, Access Key, and Secret Key. Amazon also states that Product Advertising API access is tied to the marketplace/locale where the Associate account is registered. ([Amazon Web Services][1])

For this pass, do not build a full Amazon Product Advertising API integration unless the repo already has it.

This task is only:

* Add Amazon affiliate env vars.
* Add safe Amazon affiliate URL fallback.
* Preserve original Amazon URL when affiliate setup is missing.
* Avoid crashes.

## Env Vars

Add to `.env.example`:

```env
# Amazon Associates / Amazon Affiliate
AMAZON_AFFILIATE_ENABLED=false
AMAZON_ASSOCIATE_TAG=
AMAZON_MARKETPLACE=amazon.com
```

Optional future API vars:

```env
# Optional: only needed for future Amazon Product Advertising API / Creator API integration
AMAZON_ACCESS_KEY_ID=
AMAZON_SECRET_ACCESS_KEY=
AMAZON_PARTNER_TAG=
AMAZON_PARTNER_TYPE=Associates
AMAZON_REGION=us-east-1
```

## Required Behavior

If the app has a matched Amazon product URL like:

```txt
https://www.amazon.com/dp/B000EXAMPLE
```

And:

```env
AMAZON_AFFILIATE_ENABLED=true
AMAZON_ASSOCIATE_TAG=mytag-20
```

Then generate:

```txt
https://www.amazon.com/dp/B000EXAMPLE?tag=mytag-20
```

If the Amazon URL already has query params, append with `&tag=` instead of `?tag=`.

If the URL already has a `tag=` param, replace it with `AMAZON_ASSOCIATE_TAG`.

If `AMAZON_AFFILIATE_ENABLED=false`, missing tag, invalid URL, or non-Amazon URL:

* Do not throw.
* Return the original product URL.
* Mark affiliate status as unavailable or fallback.
* Keep the product card usable.

## Implementation Scope

Create a tiny helper.

Suggested file:

```txt
src/server/affiliate/providers/amazon/amazonAffiliateUrl.ts
```

Suggested function:

```ts
export function buildAmazonAffiliateUrl(input: {
  productUrl: string;
  associateTag?: string;
  enabled?: boolean;
}): {
  url: string;
  affiliateApplied: boolean;
  reason?: string;
}
```

## Logic

The helper should:

1. Validate URL.
2. Confirm hostname is Amazon:

   * amazon.com
   * [www.amazon.com](http://www.amazon.com)
   * smile.amazon.com if already present
3. Check `enabled`.
4. Check `associateTag`.
5. Add or replace the `tag` query param.
6. Return the final URL.

Do not expose Amazon env vars to the frontend.

Do not use public frontend env var names.

## Provider Fallback Logic

Where product outbound URLs are selected, use this priority:

```ts
const outboundUrl =
  rakutenAffiliateUrl ||
  cjAffiliateUrl ||
  amazonAffiliateUrl ||
  originalAmazonUrl ||
  originalProductUrl;
```

But only apply `amazonAffiliateUrl` when:

* Product URL is an Amazon URL.
* `AMAZON_AFFILIATE_ENABLED=true`.
* `AMAZON_ASSOCIATE_TAG` exists.

If Amazon affiliate cannot be applied, use the original Amazon link.

## Product Card Status

Return enough metadata for UI/admin debugging:

```ts
{
  network: "amazon",
  affiliateApplied: true,
  affiliateUnavailableReason: undefined
}
```

Or:

```ts
{
  network: "amazon",
  affiliateApplied: false,
  affiliateUnavailableReason: "Missing AMAZON_ASSOCIATE_TAG. Showing original Amazon link."
}
```

## Acceptance Criteria

Done means:

* `.env.example` includes Amazon affiliate vars.
* Amazon links can safely receive `?tag=`.
* Existing `tag=` params are replaced safely.
* Non-Amazon URLs are untouched.
* Missing Amazon env vars do not crash app.
* If Rakuten/CJ are not configured or no match exists, original Amazon link still shows.
* No frontend code receives Amazon secrets.
* No full Amazon API integration is attempted in this pass.

## Final Instruction

Make the smallest safe change.

Do not build Amazon Product Advertising API right now.

Do not refactor the whole affiliate system.

Only add Amazon affiliate URL fallback and env handling.

````

Use this one-liner for Codex:

```txt
Read AMAZON_AFFILIATE_MINI_TASK.md and implement only the small Amazon affiliate fallback. Do not build full Amazon PA-API. Add env vars, safe URL tagging, fallback to original Amazon links, and minimal tests if nearby test patterns exist.
````

[1]: https://webservices.amazon.com/paapi5/scratchpad/?utm_source=chatgpt.com "Product Advertising API 5.0 Scratchpad"

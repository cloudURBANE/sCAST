import axios from "axios";
import * as cheerio from "cheerio";

const DEFAULT_BASE_URL = "https://api.linksynergy.com";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_PRODUCT_LIMIT = 10;
const MAX_PRODUCT_LIMIT = 100;
const UNSUPPORTED_SEARCH_CHARS = /[&=?{}\\()[\]\-;~|$!><*%]+/g;

export type RakutenAdvertiser = {
  id: string;
  name: string | null;
  url: string | null;
  canPartner: boolean | null;
  supportsDeepLinks: boolean | null;
  hasProductFeed: boolean | null;
};

export type RakutenProduct = {
  provider: "rakuten";
  advertiserId: string;
  advertiserName: string | null;
  productLinkId: string | null;
  sku: string | null;
  title: string;
  brand: string | null;
  categoryPrimary: string | null;
  categorySecondary: string | null;
  price: string | null;
  salePrice: string | null;
  currency: string | null;
  destinationUrl: string | null;
  imageUrl: string | null;
  matchScore: number;
  affiliateUrl: string | null;
  affiliateUnavailableReason: string | null;
};

export type RakutenProductSearchOptions = {
  keyword?: string;
  exact?: string;
  one?: string;
  none?: string;
  category?: string;
  language?: string;
  max?: number;
  pageNumber?: number;
  advertiserId?: string;
  sort?: Array<"retailprice" | "productname" | "categoryname" | "mid">;
  sortType?: Array<"asc" | "dsc">;
};

export type RakutenBuyLinkResult =
  | { status: "active"; product: RakutenProduct & { affiliateUrl: string } }
  | { status: "unavailable"; reason: string; products: RakutenProduct[] };

type RakutenDeepLinkResponse = {
  advertiser?: {
    deep_link?: {
      deep_link_url?: string;
      url?: string;
      u1?: string;
    };
  };
};

type RakutenDeepLinkErrorResponse = {
  error?: string;
  errors?: Array<{ code?: string; message?: string }>;
  message?: string;
};

function getAccessToken(): string | null {
  return (
    process.env.RAKUTEN_ADVERTISING_ACCESS_TOKEN?.trim() ||
    process.env.RAKUTEN_API_ACCESS_TOKEN?.trim() ||
    null
  );
}

function getBaseUrl(): string {
  return (process.env.RAKUTEN_ADVERTISING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getConfiguredAdvertiserIds(): string[] {
  const raw = process.env.RAKUTEN_ADVERTISING_MIDS || process.env.RAKUTEN_ADVERTISER_MIDS || "";
  return raw
    .split(/[|,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampProductLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PRODUCT_LIMIT;
  return Math.max(1, Math.min(MAX_PRODUCT_LIMIT, Math.trunc(value ?? DEFAULT_PRODUCT_LIMIT)));
}

function text(value: cheerio.Cheerio<any>, selector: string): string | null {
  const raw = value.find(selector).first().text().trim();
  return raw || null;
}

function attr(value: cheerio.Cheerio<any>, selector: string, name: string): string | null {
  const raw = value.find(selector).first().attr(name)?.trim();
  return raw || null;
}

export function sanitizeRakutenSearchTerm(value: string): string {
  return value.replace(UNSUPPORTED_SEARCH_CHARS, " ").replace(/\s+/g, " ").trim();
}

function parsePrice(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? cleaned : null;
}

function scoreProduct(
  product: Omit<RakutenProduct, "matchScore" | "affiliateUrl" | "affiliateUnavailableReason">,
  query: string,
): number {
  const haystack = [
    product.title,
    product.advertiserName,
    product.categoryPrimary,
    product.categorySecondary,
    product.sku,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const terms = sanitizeRakutenSearchTerm(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);

  if (!terms.length) return 0;

  const matched = terms.filter((term) => haystack.includes(term)).length;
  let score = matched / terms.length;
  if (terms.length > 1 && haystack.includes(terms.join(" "))) score += 0.35;
  if (product.destinationUrl) score += 0.1;
  if (product.imageUrl) score += 0.05;
  return Math.min(1, Number(score.toFixed(4)));
}

export function parseRakutenProductSearchXml(xml: string, query = ""): RakutenProduct[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const products: RakutenProduct[] = [];

  $("item").each((_, element) => {
    const item = $(element);
    const title = text(item, "productname");
    const advertiserId = text(item, "mid");
    if (!title || !advertiserId) return;

    const salePrice = parsePrice(text(item, "saleprice"));
    const price = parsePrice(text(item, "price"));
    const base = {
      provider: "rakuten" as const,
      advertiserId,
      advertiserName: text(item, "merchantname"),
      productLinkId: text(item, "linkid"),
      sku: text(item, "sku"),
      title,
      brand: null,
      categoryPrimary: text(item, "category primary"),
      categorySecondary: text(item, "category secondary"),
      price,
      salePrice,
      currency: attr(item, "saleprice", "currency") || attr(item, "price", "currency"),
      destinationUrl: text(item, "linkurl"),
      imageUrl: text(item, "imageurl"),
    };

    products.push({
      ...base,
      matchScore: scoreProduct(base, query),
      affiliateUrl: null,
      affiliateUnavailableReason: null,
    });
  });

  return dedupeRakutenProducts(products);
}

export function dedupeRakutenProducts(products: RakutenProduct[]): RakutenProduct[] {
  const seen = new Set<string>();
  const unique: RakutenProduct[] = [];

  for (const product of products) {
    const key = [
      product.advertiserId,
      product.sku || product.productLinkId || product.destinationUrl || product.title.toLowerCase(),
      product.salePrice || product.price || "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(product);
  }

  return unique.sort((a, b) => b.matchScore - a.matchScore);
}

function bearerHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function deepLinkFailureReason(status: number, body: RakutenDeepLinkErrorResponse | string | undefined): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 160);
  if (!body || typeof body === "string") return `HTTP_${status}`;

  const firstError = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  const code = firstError?.code || body?.error;
  if (code) return code;
  if (firstError?.message) return firstError.message;
  if (body?.message) return body.message;
  return `HTTP_${status}`;
}

export class RakutenAdvertisingProvider {
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(options?: { accessToken?: string; baseUrl?: string }) {
    const token = options?.accessToken?.trim() || getAccessToken();
    if (!token) {
      throw new Error("RAKUTEN_ADVERTISING_ACCESS_TOKEN is required");
    }

    this.accessToken = token;
    this.baseUrl = (options?.baseUrl || getBaseUrl()).replace(/\/+$/, "");
  }

  async getAdvertiser(advertiserId: string): Promise<RakutenAdvertiser | null> {
    const response = await axios.get(`${this.baseUrl}/v2/advertisers/${encodeURIComponent(advertiserId)}`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: bearerHeaders(this.accessToken),
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status !== 200) {
      console.warn("[rakuten] advertiser lookup failed", { status: response.status, advertiserId });
      return null;
    }

    const advertiser = response.data?.advertiser;
    if (!advertiser?.id) return null;

    return {
      id: String(advertiser.id),
      name: typeof advertiser.name === "string" ? advertiser.name : null,
      url: typeof advertiser.url === "string" ? advertiser.url : null,
      canPartner: typeof advertiser.can_partner === "boolean" ? advertiser.can_partner : null,
      supportsDeepLinks: typeof advertiser.features?.deep_links === "boolean" ? advertiser.features.deep_links : null,
      hasProductFeed: typeof advertiser.features?.product_feed === "boolean" ? advertiser.features.product_feed : null,
    };
  }

  async searchProducts(options: RakutenProductSearchOptions): Promise<RakutenProduct[]> {
    const params = new URLSearchParams();
    const keyword = options.keyword ? sanitizeRakutenSearchTerm(options.keyword) : "";
    const exact = options.exact ? sanitizeRakutenSearchTerm(options.exact) : "";
    const one = options.one ? sanitizeRakutenSearchTerm(options.one) : "";
    const none = options.none ? sanitizeRakutenSearchTerm(options.none) : "";

    if (keyword) params.set("keyword", keyword);
    if (exact) params.set("exact", exact);
    if (one) params.set("one", one);
    if (none) params.set("none", none);
    if (options.category) params.set("cat", sanitizeRakutenSearchTerm(options.category));
    if (options.language) params.set("language", options.language);
    params.set("max", String(clampProductLimit(options.max)));
    params.set("pagenumber", String(Math.max(1, Math.trunc(options.pageNumber ?? 1))));
    if (options.advertiserId) params.set("mid", options.advertiserId);

    for (const sort of options.sort ?? []) params.append("sort", sort);
    for (const sortType of options.sortType ?? []) params.append("sorttype", sortType);

    const response = await axios.get(`${this.baseUrl}/productsearch/1.0?${params.toString()}`, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: bearerHeaders(this.accessToken),
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status !== 200) {
      console.warn("[rakuten] product search failed", { status: response.status });
      return [];
    }

    return parseRakutenProductSearchXml(String(response.data), keyword || exact || one);
  }

  async createDeepLink(input: { advertiserId: string; url: string; u1?: string }): Promise<string> {
    const body = {
      url: input.url,
      advertiser_id: Number.isFinite(Number(input.advertiserId)) ? Number(input.advertiserId) : input.advertiserId,
      ...(input.u1 ? { u1: input.u1 } : {}),
    };

    const response = await axios.post<RakutenDeepLinkResponse | RakutenDeepLinkErrorResponse>(
      `${this.baseUrl}/v1/links/deep_links`,
      body,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          ...bearerHeaders(this.accessToken),
          "content-type": "application/json",
        },
        validateStatus: (status) => status >= 200 && status < 500,
      },
    );

    const deepLinkUrl = (response.data as RakutenDeepLinkResponse)?.advertiser?.deep_link?.deep_link_url;
    if (response.status >= 200 && response.status < 300 && typeof deepLinkUrl === "string" && deepLinkUrl) {
      return deepLinkUrl;
    }

    throw new Error(deepLinkFailureReason(response.status, response.data as RakutenDeepLinkErrorResponse));
  }

  async resolveBuyLink(input: {
    query: string;
    advertiserIds?: string[];
    u1?: string;
    maxProducts?: number;
  }): Promise<RakutenBuyLinkResult> {
    const advertiserIds = input.advertiserIds?.length ? input.advertiserIds : getConfiguredAdvertiserIds();
    const maxProducts = clampProductLimit(
      input.maxProducts ?? numberFromEnv("RAKUTEN_ADVERTISING_PRODUCT_MAX", DEFAULT_PRODUCT_LIMIT),
    );
    const u1 = input.u1 ?? process.env.RAKUTEN_ADVERTISING_U1;
    const products: RakutenProduct[] = [];
    const advertiserDeepLinkSupport = new Map<string, boolean | null>();

    if (advertiserIds.length) {
      await Promise.all(
        advertiserIds.map(async (advertiserId) => {
          const advertiser = await this.getAdvertiser(advertiserId);
          advertiserDeepLinkSupport.set(advertiserId, advertiser?.supportsDeepLinks ?? null);
        }),
      );
    }

    const searchTargets = advertiserIds.length ? advertiserIds : [undefined];
    for (const advertiserId of searchTargets) {
      if (advertiserId && advertiserDeepLinkSupport.get(advertiserId) === false) {
        continue;
      }

      const found = await this.searchProducts({
        keyword: input.query,
        advertiserId,
        max: maxProducts,
        pageNumber: 1,
        sort: ["productname"],
        sortType: ["asc"],
      });
      products.push(...found);
    }

    const candidates = dedupeRakutenProducts(products).slice(0, maxProducts);
    if (!candidates.length) {
      return { status: "unavailable", reason: "NO_PRODUCT_RESULTS", products: [] };
    }

    for (const product of candidates) {
      if (!product.destinationUrl) {
        product.affiliateUnavailableReason = "MISSING_PRODUCT_URL";
        continue;
      }

      const knownDeepLinkSupport = advertiserDeepLinkSupport.get(product.advertiserId);
      if (knownDeepLinkSupport === false) {
        product.affiliateUnavailableReason = "DEEP_LINKING_NOT_ENABLED";
        continue;
      }

      try {
        const affiliateUrl = await this.createDeepLink({
          advertiserId: product.advertiserId,
          url: product.destinationUrl,
          u1,
        });
        return { status: "active", product: { ...product, affiliateUrl } };
      } catch (err: any) {
        product.affiliateUnavailableReason = err?.message || "DEEP_LINK_FAILED";
        console.info("[rakuten] deep link unavailable for product candidate", {
          advertiserId: product.advertiserId,
          reason: product.affiliateUnavailableReason,
        });
      }
    }

    return {
      status: "unavailable",
      reason:
        candidates.find((product) => product.affiliateUnavailableReason)?.affiliateUnavailableReason ||
        "DEEP_LINK_UNAVAILABLE",
      products: candidates,
    };
  }
}

export function rakutenEnvReady(): boolean {
  return Boolean(getAccessToken());
}

export function createRakutenProvider(): RakutenAdvertisingProvider {
  return new RakutenAdvertisingProvider();
}

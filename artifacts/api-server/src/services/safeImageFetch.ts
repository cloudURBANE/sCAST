import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

// Some CDNs label perfectly valid JPEGs with non-canonical types. Normalize these
// to image/jpeg so a real packshot isn't rejected on a cosmetic header mismatch.
const JPEG_CONTENT_TYPE_ALIASES = new Set(["image/jpg", "image/pjpeg"]);

// Content types that carry no reliable signal about the payload. Retailer/image-transform
// CDNs frequently serve real images this way (or with no content-type at all). For these we
// fall back to magic-byte sniffing instead of rejecting outright. Anything else that isn't an
// allowed image type (e.g. text/html from a social crawler page) is still fast-rejected.
const SNIFFABLE_CONTENT_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
]);

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);

/** Detect an allowed image type from leading magic bytes; returns the MIME or null. */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // GIF: "GIF8"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "image/gif";
  }
  // WEBP: "RIFF"...."WEBP"
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  // AVIF/HEIF: "....ftyp" box with an avif brand
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70
  ) {
    const brand = buffer.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

/**
 * Positive markup/text signal: the body begins with `<` (after an optional BOM
 * and leading ASCII whitespace). Used to reject HTML error/WAF pages that are
 * served behind an `image/*` content-type. None of the raster formats we accept
 * (JPEG/PNG/GIF/WebP/AVIF) start with `<`, so this never trips on a genuine
 * image while reliably catching disguised markup.
 */
export function looksLikeMarkupOrText(buffer: Buffer): boolean {
  let i = 0;
  // Skip a UTF-8 BOM.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    i = 3;
  }
  // Skip leading ASCII whitespace (space, tab, LF, CR).
  while (
    i < buffer.length &&
    (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0a || buffer[i] === 0x0d)
  ) {
    i += 1;
  }
  return i < buffer.length && buffer[i] === 0x3c; // '<'
}

export type SafeImageFetchResult = {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
  sizeBytes: number;
};

export class UnsafeImageUrlError extends Error {
  /**
   * True when the failure is transient/infrastructure (upstream 5xx/429, DNS
   * hiccup) rather than a deterministic problem with the URL or its content.
   * The image pipeline's negative cache keys off this so a passing blip does
   * not black out a source for every caller for hours (image-pipeline audit).
   */
  readonly transient: boolean;
  constructor(message: string, options?: { transient?: boolean }) {
    super(message);
    this.name = "UnsafeImageUrlError";
    this.transient = options?.transient ?? false;
  }
}

function ipToNumber(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(address: string): boolean {
  const n = ipToNumber(address);
  return (
    (n >= ipToNumber("0.0.0.0") && n <= ipToNumber("0.255.255.255")) ||
    (n >= ipToNumber("10.0.0.0") && n <= ipToNumber("10.255.255.255")) ||
    (n >= ipToNumber("100.64.0.0") && n <= ipToNumber("100.127.255.255")) || // CGNAT
    (n >= ipToNumber("127.0.0.0") && n <= ipToNumber("127.255.255.255")) ||
    (n >= ipToNumber("169.254.0.0") && n <= ipToNumber("169.254.255.255")) || // link-local incl. cloud metadata
    (n >= ipToNumber("172.16.0.0") && n <= ipToNumber("172.31.255.255")) ||
    (n >= ipToNumber("192.168.0.0") && n <= ipToNumber("192.168.255.255")) ||
    (n >= ipToNumber("224.0.0.0") && n <= ipToNumber("239.255.255.255")) || // multicast
    (n >= ipToNumber("240.0.0.0") && n <= ipToNumber("255.255.255.255")) // reserved + broadcast
  );
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped/-compatible IPv6 address, in either
 * the dotted (`::ffff:169.254.169.254`) or hex (`::ffff:a9fe:a9fe`) form, so the
 * IPv4 private-range predicate can be applied. Returns null for a genuine IPv6.
 */
function extractMappedIpv4(normalized: string): string | null {
  const dotted = normalized.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];

  const hex = normalized.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateIpAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    return isPrivateIpv4(address);
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    // An IPv4-mapped/-compatible address (e.g. `::ffff:169.254.169.254`) reaches the
    // SAME host as its embedded IPv4, so it must be judged by the IPv4 predicate —
    // otherwise mapped metadata/loopback/private ranges slip past the IPv6 checks.
    const mapped = extractMappedIpv4(normalized);
    if (mapped) return isPrivateIpv4(mapped);

    return (
      normalized === "::1" || // loopback
      normalized === "::" || // unspecified
      normalized.startsWith("fc") || // unique local (fc00::/7)
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") || // link-local
      normalized.startsWith("ff") // multicast (ff00::/8)
    );
  }

  return true;
}

export function parseAndValidateExternalImageUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeImageUrlError("Invalid image URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeImageUrlError("Only http/https image URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeImageUrlError("Image URLs with credentials are not allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".local")) {
    throw new UnsafeImageUrlError("Local image hosts are not allowed");
  }
  // `URL.hostname` keeps IPv6 literals bracketed (e.g. `[::1]`, `[::ffff:a9fe:a9fe]`),
  // and `net.isIP("[::1]")` is 0 — so without stripping the brackets the literal-IP
  // guard is silently skipped for EVERY IPv6 literal (loopback, ULA, mapped metadata).
  // The socket connects to the un-bracketed address, so validate that same form here.
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(bareHost) && isPrivateIpAddress(bareHost)) {
    throw new UnsafeImageUrlError("Private network image URLs are not allowed");
  }

  return parsed;
}

/**
 * A `net.LookupFunction` that resolves the hostname ONCE, rejects the whole
 * connection if ANY resolved address is private, and hands the socket exactly the
 * addresses it validated. Because Node connects to what this callback returns (it
 * does not re-resolve), the address we approved is the address the socket reaches —
 * which closes the TOCTOU / DNS-rebinding window that a separate "validate then
 * fetch(hostname)" sequence leaves open (attacker DNS can return a public IP to the
 * validator and a private IP to the connect). Literal-IP hosts are already rejected
 * up-front by `parseAndValidateExternalImageUrl`; this re-checks resolved records.
 */
const pinnedPublicLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: false }, (err, addresses) => {
    if (err) {
      // DNS can fail intermittently; treat a non-resolving host as transient so
      // the pipeline retries on the next request instead of negative-caching it.
      callback(new UnsafeImageUrlError("Image host did not resolve", { transient: true }), "", 0);
      return;
    }

    const records = Array.isArray(addresses) ? addresses : [];
    if (records.length === 0) {
      callback(new UnsafeImageUrlError("Image host did not resolve", { transient: true }), "", 0);
      return;
    }

    for (const record of records) {
      if (isPrivateIpAddress(record.address)) {
        callback(
          new UnsafeImageUrlError("Image host resolves to a private network address"),
          "",
          0,
        );
        return;
      }
    }

    // Node's default Happy-Eyeballs (autoSelectFamily) calls this with `all: true`
    // and expects the full validated list; otherwise return the first validated hit.
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      callback(null, records);
    } else {
      callback(null, records[0].address, records[0].family);
    }
  });
};

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function anyAbortSignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (any) return any(signals);

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

async function readLimitedBody(stream: Readable, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const value of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    // Free the socket promptly on early exit (size cap / abort / validation reject).
    stream.destroy();
  }

  return Buffer.concat(chunks, total);
}

type RawImageResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
};

/**
 * Issue a single (non-redirect-following) GET pinned to a validated public address
 * via {@link pinnedPublicLookup}. Uses `node:http`/`node:https` directly rather than
 * global `fetch` because only the low-level agent lets us supply a custom `lookup`,
 * which is what pins the connection to the address we validated.
 */
function requestImageOnce(url: URL, signal: AbortSignal): Promise<RawImageResponse> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<RawImageResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        signal,
        lookup: pinnedPublicLookup,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.95,*/*;q=0.1",
          Referer: `${url.origin}/`,
        },
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          stream: response,
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export async function fetchExternalImage(
  rawUrl: string,
  options?: {
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SafeImageFetchResult> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = parseAndValidateExternalImageUrl(rawUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    throwIfAborted(options?.signal);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? anyAbortSignal([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await requestImageOnce(current, signal);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      response.stream.destroy();
      if (!location) throw new UnsafeImageUrlError("Image redirect missing location");
      current = parseAndValidateExternalImageUrl(new URL(location, current).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.stream.destroy();
      // 5xx and 429 are upstream-side and usually recover; mark them transient
      // so they are not negative-cached. 4xx (404/403/410/…) are deterministic.
      const transient = response.status >= 500 || response.status === 429;
      throw new UnsafeImageUrlError(`Image fetch failed with HTTP ${response.status}`, {
        transient,
      });
    }

    const contentLength = Number(response.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      response.stream.destroy();
      throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
    }

    const contentTypeHeader = response.headers["content-type"];
    const declaredType = normalizeContentType(
      Array.isArray(contentTypeHeader) ? contentTypeHeader[0] ?? null : contentTypeHeader ?? null,
    );
    const resolvedType = JPEG_CONTENT_TYPE_ALIASES.has(declaredType) ? "image/jpeg" : declaredType;

    const isAllowedDeclared = ALLOWED_IMAGE_MIME_TYPES.has(resolvedType);
    // Fast-reject obviously-non-image types (e.g. text/html from a social crawler page)
    // before downloading the body. Ambiguous types fall through to magic-byte sniffing.
    if (!isAllowedDeclared && !SNIFFABLE_CONTENT_TYPES.has(resolvedType)) {
      response.stream.destroy();
      throw new UnsafeImageUrlError(`Unsupported image content type: ${resolvedType || "unknown"}`);
    }

    const buffer = await readLimitedBody(response.stream, maxBytes, signal);

    // A real image is never empty. An empty 200 body (some retailers/WAFs return
    // one behind an image content-type) decodes to naturalWidth === 0 in the
    // browser — exactly the "poisoned" payload that stranded the bottle skeleton.
    if (buffer.length === 0) {
      throw new UnsafeImageUrlError("Image body was empty");
    }

    let contentType = resolvedType;
    if (!isAllowedDeclared) {
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) {
        throw new UnsafeImageUrlError(
          `Unsupported image content type: ${resolvedType || "unknown"} (no image signature)`,
        );
      }
      contentType = sniffed;
    } else if (looksLikeMarkupOrText(buffer)) {
      // The header declared an allowed image type, but the bytes are HTML/markup
      // — a WAF challenge or error page wearing an `image/*` content-type. Reject
      // it: the proxy then returns 502 (the cache never stores loader rejections,
      // so the garbage can't poison the shared cache) and the client falls through
      // to "Unavailable" instead of an endless skeleton.
      throw new UnsafeImageUrlError("Image body was not a decodable image (markup payload)");
    }

    return {
      buffer,
      contentType,
      finalUrl: current.toString(),
      sizeBytes: buffer.length,
    };
  }

  throw new UnsafeImageUrlError("Too many image redirects");
}

import { lookup } from "node:dns/promises";
import net from "node:net";

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
  constructor(message: string) {
    super(message);
    this.name = "UnsafeImageUrlError";
  }
}

function ipToNumber(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPrivateIpAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const n = ipToNumber(address);
    return (
      (n >= ipToNumber("0.0.0.0") && n <= ipToNumber("0.255.255.255")) ||
      (n >= ipToNumber("10.0.0.0") && n <= ipToNumber("10.255.255.255")) ||
      (n >= ipToNumber("127.0.0.0") && n <= ipToNumber("127.255.255.255")) ||
      (n >= ipToNumber("169.254.0.0") && n <= ipToNumber("169.254.255.255")) ||
      (n >= ipToNumber("172.16.0.0") && n <= ipToNumber("172.31.255.255")) ||
      (n >= ipToNumber("192.168.0.0") && n <= ipToNumber("192.168.255.255")) ||
      (n >= ipToNumber("224.0.0.0") && n <= ipToNumber("239.255.255.255"))
    );
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
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
  if (net.isIP(hostname) && isPrivateIpAddress(hostname)) {
    throw new UnsafeImageUrlError("Private network image URLs are not allowed");
  }

  return parsed;
}

async function assertPublicDnsTarget(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new UnsafeImageUrlError("Private network image URLs are not allowed");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) {
    throw new UnsafeImageUrlError("Image host did not resolve");
  }

  for (const record of addresses) {
    if (isPrivateIpAddress(record.address)) {
      throw new UnsafeImageUrlError("Image host resolves to a private network address");
    }
  }
}

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

async function readLimitedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    throwIfAborted(signal);
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
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
    await assertPublicDnsTarget(current.hostname);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? anyAbortSignal([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.95,*/*;q=0.1",
        "Referer": `${current.origin}/`,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new UnsafeImageUrlError("Image redirect missing location");
      current = parseAndValidateExternalImageUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) {
      throw new UnsafeImageUrlError(`Image fetch failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
    }

    const declaredType = normalizeContentType(response.headers.get("content-type"));
    const resolvedType = JPEG_CONTENT_TYPE_ALIASES.has(declaredType) ? "image/jpeg" : declaredType;

    const isAllowedDeclared = ALLOWED_IMAGE_MIME_TYPES.has(resolvedType);
    // Fast-reject obviously-non-image types (e.g. text/html from a social crawler page)
    // before downloading the body. Ambiguous types fall through to magic-byte sniffing.
    if (!isAllowedDeclared && !SNIFFABLE_CONTENT_TYPES.has(resolvedType)) {
      throw new UnsafeImageUrlError(`Unsupported image content type: ${resolvedType || "unknown"}`);
    }

    const buffer = await readLimitedBody(response, maxBytes, signal);

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

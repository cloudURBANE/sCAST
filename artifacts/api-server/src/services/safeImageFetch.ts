import dns from "node:dns";
import http from "node:http";
import https from "node:https";
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

/** Strip the surrounding brackets a URL keeps on an IPv6-literal hostname. */
function normalizeIpLiteral(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// Private / reserved / special-use address ranges that must never be reachable
// through the image proxy (SSRF guard). Built once at module load.
//
// net.BlockList.check() resolves an IPv4-mapped IPv6 address (::ffff:a.b.c.d, in
// either the dotted or the hex form Node/DNS may produce) against the IPv4 rules
// automatically, so every IPv4 range below also covers its mapped-IPv6 form. This
// closes the mapped-IPv6 bypass (e.g. `[::ffff:169.254.169.254]` → cloud metadata,
// `::ffff:100.64.x.x` → CGNAT, mapped 0.0.0.0/8 and multicast) without maintaining
// a second, hand-written IPv6 predicate that previously omitted those ranges.
const PRIVATE_IP_BLOCK_LIST: net.BlockList = (() => {
  const list = new net.BlockList();
  // IPv4 (and, via BlockList, their IPv4-mapped IPv6 equivalents).
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / 0.0.0.0
  list.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
  list.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT (RFC6598)
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. cloud metadata 169.254.169.254
  list.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
  list.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + 255.255.255.255 broadcast
  // Native IPv6 special ranges.
  list.addAddress("::", "ipv6"); // unspecified
  list.addAddress("::1", "ipv6"); // loopback
  list.addSubnet("fc00::", 7, "ipv6"); // unique local (fc00::/7 → fc/fd)
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  return list;
})();

export function isPrivateIpAddress(address: string): boolean {
  const ip = normalizeIpLiteral(address.trim().toLowerCase());
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE_IP_BLOCK_LIST.check(ip, "ipv4");
  if (family === 6) return PRIVATE_IP_BLOCK_LIST.check(ip, "ipv6");
  // Not an IP literal (a hostname, or unparseable): treat as unsafe by default so
  // callers must resolve + re-check the concrete address before connecting.
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
  // URL keeps the brackets on an IPv6-literal hostname (e.g. "[::ffff:169.254.169.254]");
  // strip them so net.isIP recognizes the literal and the private-range guard runs.
  const ipLiteral = normalizeIpLiteral(hostname);
  if (net.isIP(ipLiteral) && isPrivateIpAddress(ipLiteral)) {
    throw new UnsafeImageUrlError("Private network image URLs are not allowed");
  }

  return parsed;
}

/**
 * A DNS lookup that resolves the hostname ONCE, rejects if it (or any A/AAAA
 * record it returns) points at a private/reserved address, then hands
 * net.connect exactly those pre-validated addresses. Because the socket connects
 * to the addresses this function returns — with no second, independent
 * resolution between validation and connect — a low-TTL DNS-rebinding attacker
 * cannot swap in a private IP after the check passes (the A1 TOCTOU: the old code
 * validated with dns.lookup and then let fetch() re-resolve the hostname).
 *
 * Node bypasses this lookup for IP-literal hosts (it connects to the literal
 * directly); those are already screened synchronously by
 * parseAndValidateExternalImageUrl before we ever start a request.
 */
const pinnedPublicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: false }, (err, addresses) => {
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
    if (options.all) {
      callback(null, records);
    } else {
      callback(null, records[0].address, records[0].family);
    }
  });
};

type ImageRequestHop = {
  response: http.IncomingMessage;
  request: http.ClientRequest;
  /** Combined caller + per-hop timeout signal; also governs the body read. */
  signal: AbortSignal;
  /** True once the per-hop timeout fired (vs. a caller-initiated abort). */
  timedOut: () => boolean;
  /** Clear the per-hop timeout timer once the hop is fully handled. */
  dispose: () => void;
};

/**
 * Start one hop of the image fetch over node:http / node:https so we can pin the
 * connection to a pre-validated IP via `lookup`. Resolves once response headers
 * arrive; the returned `signal` (caller signal + per-hop timeout) also bounds the
 * body read, matching the previous single-timeout-per-hop behavior.
 */
function startImageRequest(
  url: URL,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ImageRequestHop> {
  return new Promise<ImageRequestHop>((resolve, reject) => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new UnsafeImageUrlError("Image fetch timed out", { transient: true }));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const dispose = () => clearTimeout(timer);
    const timedOut = () => timeoutController.signal.aborted;

    const signal = callerSignal
      ? anyAbortSignal([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "GET",
        // Pin the socket to the address our validated lookup returns. `servername`
        // / Host header stay derived from the hostname, so TLS SNI and certificate
        // validation are unaffected — only the resolved IP is controlled.
        lookup: pinnedPublicLookup,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.95,*/*;q=0.1",
          "Referer": `${url.origin}/`,
        },
      },
      (response) => {
        resolve({ response, request, signal, timedOut, dispose });
      },
    );
    request.on("error", (err) => {
      dispose();
      // A per-hop timeout surfaces here as an abort; normalize it to a transient
      // UnsafeImageUrlError so it is not negative-cached (matches prior semantics).
      if (timedOut()) {
        reject(new UnsafeImageUrlError("Image fetch timed out", { transient: true }));
        return;
      }
      reject(err);
    });
    request.end();
  });
}

async function readLimitedNodeStream(
  stream: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        stream.destroy();
        throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
  } catch (err) {
    // A timeout / caller abort tears down the stream mid-read; re-check the signal
    // so we surface the abort reason (or timeout) rather than a raw socket error.
    throwIfAborted(signal);
    throw err;
  }
  return Buffer.concat(chunks, total);
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

    // Connect over node:http/https with a pinned lookup so the socket lands on the
    // exact address our SSRF guard validated (no re-resolution → no DNS-rebinding
    // TOCTOU). Manual redirect handling: node does not auto-follow, so each hop is
    // re-validated by parseAndValidateExternalImageUrl below.
    const hop = await startImageRequest(current, timeoutMs, options?.signal);
    const { response, signal } = hop;
    try {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        if (!location) throw new UnsafeImageUrlError("Image redirect missing location");
        response.resume(); // drain so the socket is released before the next hop
        current = parseAndValidateExternalImageUrl(new URL(location, current).toString());
        continue;
      }

      if (status < 200 || status >= 300) {
        // 5xx and 429 are upstream-side and usually recover; mark them transient
        // so they are not negative-cached. 4xx (404/403/410/…) are deterministic.
        response.resume();
        const transient = status >= 500 || status === 429;
        throw new UnsafeImageUrlError(`Image fetch failed with HTTP ${status}`, { transient });
      }

      const contentLengthHeader = response.headers["content-length"];
      const contentLength = Number(contentLengthHeader ?? "0");
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.resume();
        throw new UnsafeImageUrlError(`Image exceeds ${maxBytes} bytes`);
      }

      const declaredType = normalizeContentType(response.headers["content-type"] ?? null);
      const resolvedType = JPEG_CONTENT_TYPE_ALIASES.has(declaredType) ? "image/jpeg" : declaredType;

      const isAllowedDeclared = ALLOWED_IMAGE_MIME_TYPES.has(resolvedType);
      // Fast-reject obviously-non-image types (e.g. text/html from a social crawler page)
      // before downloading the body. Ambiguous types fall through to magic-byte sniffing.
      if (!isAllowedDeclared && !SNIFFABLE_CONTENT_TYPES.has(resolvedType)) {
        response.resume();
        throw new UnsafeImageUrlError(`Unsupported image content type: ${resolvedType || "unknown"}`);
      }

      const buffer = await readLimitedNodeStream(response, maxBytes, signal);

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
    } finally {
      hop.dispose();
    }
  }

  throw new UnsafeImageUrlError("Too many image redirects");
}

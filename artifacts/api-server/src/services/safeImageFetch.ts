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
]);

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);

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

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
  },
): Promise<SafeImageFetchResult> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = parseAndValidateExternalImageUrl(rawUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicDnsTarget(current.hostname);

    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/avif,image/webp,image/png,image/jpeg;q=0.95,*/*;q=0.1",
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

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
      throw new UnsafeImageUrlError(`Unsupported image content type: ${contentType || "unknown"}`);
    }

    const buffer = await readLimitedBody(response, maxBytes);
    return {
      buffer,
      contentType,
      finalUrl: current.toString(),
      sizeBytes: buffer.length,
    };
  }

  throw new UnsafeImageUrlError("Too many image redirects");
}

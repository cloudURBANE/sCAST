/**
 * Beam Agent — agent delegation token (plan §14).
 *
 * A compact, HMAC-signed (HS256) token the ScentBeam API mints per run (or, for
 * owner/dev mode, once for the owner) and hands to Hermes. Hermes presents it to
 * the Beam MCP server as `Authorization: Bearer <token>`. The MCP server VERIFIES
 * the token and derives tenant/user scope FROM IT — never from model-supplied
 * arguments. This is the security boundary that lets a model call `beam_*` tools
 * without ever being able to widen its own access.
 *
 * DEPENDENCY-FREE on purpose (Node `crypto` only): the security-critical logic is
 * unit-testable in isolation, with no MCP SDK, DB, or HTTP framework in the way.
 *
 * This is intentionally JWT-shaped but bespoke (typ "BEAM-DLG") so it can never be
 * confused with, or accepted by, any other JWT verifier in the system.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

/** Issuer/audience are fixed so a token minted for something else won't verify. */
export const BEAM_TOKEN_ISS = "scentbeam-api";
export const BEAM_TOKEN_AUD = "beam-tools";

/** Read-only scopes for Phase-1 tools. Write scopes are deliberately absent. */
export type BeamScope =
  | "beam:user-context:read"
  | "beam:wardrobe:read"
  | "beam:catalog:read"
  | "beam:details:read"
  | "beam:score:read";

export type DelegationClaims = {
  iss: string;
  aud: string;
  /** Subject = the ScentBeam user id the run acts for. */
  sub: string;
  tenantId: string;
  /** Optional id of the originating run (audit/trace). */
  runId?: string;
  scope: BeamScope[];
  /** Seconds since epoch. */
  iat: number;
  exp: number;
  /** Unique token id (replay tracking / audit). */
  jti: string;
};

/** Claims the caller supplies; iat/exp/jti/iss/aud are filled in by the minter. */
export type MintInput = {
  userId: string;
  tenantId: string;
  scope: BeamScope[];
  /** Time-to-live in seconds (default 1h). Owner tokens may use a longer TTL. */
  ttlSeconds?: number;
  runId?: string;
  /** Override "now" (seconds) for deterministic tests. */
  nowSeconds?: number;
};

const HEADER = { alg: "HS256", typ: "BEAM-DLG" } as const;

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecodeToString(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/** Mint a signed delegation token. Throws on missing/empty secret. */
export function signDelegationToken(input: MintInput, secret: string): string {
  if (!secret) throw new Error("delegation token secret is empty");
  if (!input.userId || !input.tenantId) {
    throw new Error("delegation token requires userId and tenantId");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 3600;
  const claims: DelegationClaims = {
    iss: BEAM_TOKEN_ISS,
    aud: BEAM_TOKEN_AUD,
    sub: input.userId,
    tenantId: input.tenantId,
    scope: input.scope,
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
    ...(input.runId ? { runId: input.runId } : {}),
  };

  const encHeader = b64urlEncode(JSON.stringify(HEADER));
  const encPayload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = b64urlEncode(hmac(secret, signingInput));
  return `${signingInput}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: DelegationClaims }
  | { ok: false; error: string };

export type VerifyOptions = {
  /** Override "now" (seconds) for deterministic tests. */
  nowSeconds?: number;
  /** Clock-skew tolerance in seconds (default 30). */
  leewaySeconds?: number;
};

/**
 * Verify a delegation token. Returns a typed result rather than throwing so the
 * HTTP layer can map cleanly to 401/403 without try/catch noise.
 */
export function verifyDelegationToken(
  token: string,
  secret: string,
  options: VerifyOptions = {},
): VerifyResult {
  if (!secret) return { ok: false, error: "server secret not configured" };
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, error: "missing token" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed token" };
  const [encHeader, encPayload, encSig] = parts;

  // Recompute the signature and compare in constant time.
  const expectedSig = hmac(secret, `${encHeader}.${encPayload}`);
  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(encSig, "base64url");
  } catch {
    return { ok: false, error: "bad signature encoding" };
  }
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return { ok: false, error: "bad signature" };
  }

  // Header check (typ guards against cross-verifier confusion).
  let header: unknown;
  try {
    header = JSON.parse(b64urlDecodeToString(encHeader));
  } catch {
    return { ok: false, error: "bad header" };
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as Record<string, unknown>).alg !== "HS256" ||
    (header as Record<string, unknown>).typ !== "BEAM-DLG"
  ) {
    return { ok: false, error: "unexpected header" };
  }

  let claims: DelegationClaims;
  try {
    claims = JSON.parse(b64urlDecodeToString(encPayload)) as DelegationClaims;
  } catch {
    return { ok: false, error: "bad payload" };
  }

  if (claims.iss !== BEAM_TOKEN_ISS) return { ok: false, error: "bad issuer" };
  if (claims.aud !== BEAM_TOKEN_AUD) return { ok: false, error: "bad audience" };
  if (!claims.sub || !claims.tenantId) return { ok: false, error: "missing subject/tenant" };
  if (!Array.isArray(claims.scope)) return { ok: false, error: "missing scope" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const leeway = options.leewaySeconds ?? 30;
  if (typeof claims.exp !== "number" || now > claims.exp + leeway) {
    return { ok: false, error: "expired" };
  }
  if (typeof claims.iat === "number" && claims.iat - leeway > now) {
    return { ok: false, error: "issued in the future" };
  }

  return { ok: true, claims };
}

# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in ScentCast, please
report it privately rather than opening a public GitHub issue.

**Contact:** kdechecks@gmail.com

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal proof of concept, if possible).
- Any relevant logs, screenshots, or request/response samples (redact real
  user data — bearer tokens, emails — before sending).

## Response

We aim to acknowledge reports within **5 business days** and to provide a
resolution timeline within **14 days** of confirming the issue. We ask that
you give us **90 days** to address a confirmed vulnerability before any public
disclosure, and we'll keep you updated on progress throughout.

## Scope

This covers the ScentCast web app (`artifacts/scent-cast`, `artifacts/api-server`,
`lib/*`) and its infrastructure (`infra/`, `Dockerfile`, `railway.json`). The
external fragrance engine (`srt-scent-engine`) has its own repository and
security contact.

## Known Design Notes (not vulnerabilities)

- `GET /api/fragrances/search` and related engine-proxy endpoints are
  intentionally callable without authentication — they're the guest/browse
  path. Abuse protection is per-IP rate limiting, not an auth gate.
- Bearer tokens are opaque UUIDs (not JWTs) stored hashed (`users.token_hash`)
  with absolute/idle expiry — see `docs/AUTH_FLOW_MAP.md`.

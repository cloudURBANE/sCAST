# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in ScentCast, please
report it privately. **Do not open a public GitHub issue for security
problems.**

- Email: **kdechecks@gmail.com** with the subject line `SECURITY: <short summary>`.
- Prefer GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" on the repository **Security** tab) when available.

Please include enough detail to reproduce: affected endpoint/route or component,
the impact you observed, and a minimal proof of concept. Do not include live
third-party credentials in the report.

## Disclosure process

- We aim to acknowledge a report within **3 business days**.
- We ask for a **90-day** coordinated disclosure window from acknowledgement
  before public details are shared, extendable by mutual agreement while a fix
  is in progress.
- We will keep you updated on remediation progress and credit you in the fix
  notes unless you prefer to remain anonymous.

## Scope

In scope: this repository's application code — the Express API
(`artifacts/api-server`), the SPA (`artifacts/scent-cast`), the shared libraries
(`lib/*`), and the deployment infrastructure (`infra/`, `Dockerfile`,
workflows).

Out of scope: findings that require a compromised admin credential, volumetric
denial-of-service, and issues in third-party services we integrate with (report
those to the respective vendor). The database may be a **shared Supabase
project** — never test against production data or attempt to reach tables
outside this application's schema.

## Supported versions

Only the currently deployed `main` is supported. There are no long-term support
branches.

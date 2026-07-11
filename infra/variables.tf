###############################################################################
# Input variables
###############################################################################

variable "aws_region" {
  description = "AWS region for all resources. Must be us-east-1 because CloudFront requires its ACM certificate in us-east-1 and the contract keeps everything in one region."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "aws_region must be us-east-1 (CloudFront ACM cert requirement; see MIGRATION_CONTRACT.md)."
  }
}

variable "frontend_bucket_name" {
  description = "Globally-unique S3 bucket name that stores the built sCAST SPA (artifacts/scent-cast/dist/public). Private; served only via CloudFront OAC."
  type        = string
  default     = "scentbeam-frontend-prod"
}

variable "backend_origin_domain" {
  description = "Domain (host only, no scheme/path) of the Railway Express backend that /api/* is proxied to, e.g. scentbeam-api.up.railway.app. This replaces middleware.js."
  type        = string

  validation {
    condition     = length(trimspace(var.backend_origin_domain)) > 0 && !can(regex("://", var.backend_origin_domain))
    error_message = "backend_origin_domain must be a bare hostname (no https:// prefix, no path), e.g. scentbeam-api.up.railway.app."
  }
}

variable "domain_name" {
  description = "Optional custom domain for the SPA (e.g. app.scentbeam.com). When empty, CloudFront uses its default *.cloudfront.net domain and certificate and no ACM cert / alias is created."
  type        = string
  default     = ""
}

variable "alternate_domain_names" {
  description = "Additional custom domains (e.g. [\"www.scentbeam.com\"]) added to the ACM certificate as SANs and to the CloudFront aliases. Only used when domain_name is set."
  type        = list(string)
  default     = []
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone ID. When set together with domain_name, Terraform creates the ACM DNS-validation records, waits for validation, and creates an alias A/AAAA record pointing the domain at CloudFront. Leave empty if DNS is managed externally (then validate the cert manually — see README)."
  type        = string
  default     = ""
}

variable "github_owner" {
  description = "GitHub org/owner of the frontend repo used in the OIDC trust policy 'sub' claim."
  type        = string
  default     = "cloudURBANE"
}

variable "github_repo" {
  description = "GitHub repo name used in the OIDC trust policy 'sub' claim."
  type        = string
  default     = "sCAST"
}

variable "github_deploy_refs" {
  description = "Git refs (branches) allowed to assume the deploy role via OIDC. Only main deploys; the pre-cutover migration branch (claude/vercel-aws-migration-mb8vae) was removed after PR #544 merged so a stale branch can no longer push to prod."
  type        = list(string)
  default = [
    "refs/heads/main",
  ]
}

variable "csp_connect_origins" {
  description = "Origins (scheme://host) the SPA may fetch/XHR/beacon to besides its own, used in the CSP connect-src directive. Must include the Python fragrance engine (VITE_FRAGRANCE_API_URL) and any VITE_API_BASE_URL / metrics endpoints."
  type        = list(string)
  default     = ["https://srt-scent-engine-production.up.railway.app"]
}

variable "csp_img_origins" {
  description = "Origins the SPA may load images from besides its own, used in the CSP img-src directive. Include object-storage public bases (Firebase/Supabase), any VITE_IMAGE_CDN_BASES origin, and Fragrantica's image host."
  type        = list(string)
  default = [
    "https://firebasestorage.googleapis.com",
    "https://fimgs.net",
  ]
}

variable "csp_enforce" {
  description = "false (default) ships the CSP as Content-Security-Policy-Report-Only; true enforces it. Flip only after ≥1 week of violation-free reports from real traffic AND after removing index.html's inline onload handler (violates script-src 'self')."
  type        = bool
  default     = false
}

variable "csp_report_uri" {
  description = "Optional endpoint CSP violation reports are POSTed to (report-uri directive). Without it, Report-Only violations surface nowhere and the csp_enforce bake period cannot be observed. Use the Sentry security endpoint derived from the SPA project's DSN: https://oORG_ID.ingest.sentry.io/api/PROJECT_ID/security/?sentry_key=PUBLIC_KEY. Empty (default) omits the directive."
  type        = string
  default     = ""

  validation {
    condition     = var.csp_report_uri == "" || startswith(var.csp_report_uri, "https://")
    error_message = "csp_report_uri must be empty or an https:// URL."
  }
}

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_100 = US/CA/EU edges only (cheapest); PriceClass_All = all edges worldwide."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Tags applied to all resources via the provider default_tags."
  type        = map(string)
  default = {
    Project   = "sCAST"
    Component = "frontend"
    ManagedBy = "terraform"
  }
}

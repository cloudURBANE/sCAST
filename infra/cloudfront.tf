###############################################################################
# CloudFront — SPA CDN with an /api/* reverse-proxy to Railway
#
# Two origins:
#   1. S3 (private, via OAC)         -> default + static behaviors
#   2. Railway Express backend        -> /api/* behavior (replaces middleware.js)
#
# Cache-behavior mapping mirrors vercel.json (see infra/README.md for the table):
#   - default (SPA shell + unmatched routes) : no-cache HTML
#   - /api/*                                  : proxied to Railway, NEVER cached,
#                                               ALL viewer headers/cookies/query
#                                               strings forwarded (Authorization
#                                               + cookies pass through)
#   - /assets/*                               : immutable, 1 year
#   - /nav/* /icons/* /social/* /beta/* and
#     the named OG images + /favicon.svg       : browser 1 day (SWR 7 days),
#                                               CDN immutable 1 year
###############################################################################

# --- Origin Access Control (modern replacement for legacy OAI) ---------------
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.frontend_bucket_name}-oac"
  description                       = "OAC granting the sCAST CloudFront distribution read access to the private S3 origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- Managed policies referenced by data source (no hardcoded IDs) -----------
# CachingDisabled: min/default/max TTL = 0, so nothing is cached at the edge.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# AllViewerExceptHostHeader: forwards ALL viewer headers (EXCEPT Host), all
# cookies, and all query strings to the origin. We exclude Host on purpose so the
# request reaches Railway with the Railway Host (Railway routes by Host) — this
# matches middleware.js, which stripped the incoming Host header.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# --- Custom cache policy: cache static assets at the edge for 1 year ----------
# Applied to /assets/* and to the browser-cached static dirs. It forces the CDN
# to hold objects for a year regardless of their origin Cache-Control (this is
# the CloudFront analog of Vercel-CDN-Cache-Control: immutable). The header the
# BROWSER sees is set separately by the response-headers policies below.
resource "aws_cloudfront_cache_policy" "static_long" {
  name        = "scast-static-long-1yr"
  comment     = "Edge-cache static assets for 1 year (CDN immutable); viewer header set by response-headers policy"
  default_ttl = 31536000
  min_ttl     = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

###############################################################################
# Response-headers policies — reproduce the exact Cache-Control the browser sees
# and attach the security-header baseline (HSTS, nosniff, frame DENY, referrer
# policy) to every response. The HTML policy additionally carries
# Permissions-Policy and the STAGED Content-Security-Policy:
#   1. ships as Content-Security-Policy-Report-Only (never blocks),
#   2. watch violation reports for ≥1 week of real traffic,
#   3. flip csp_enforce=true only when legit traffic is violation-free.
# Known blocker for enforcing: index.html's inline `onload` font-loading hook
# violates script-src 'self' — refactor it (or add 'unsafe-hashes' + hash)
# before enforcing.
###############################################################################

locals {
  # Draft CSP from the SPA's actual needs (enumerated from artifacts/scent-cast
  # sources): Google Fonts CSS+woff2, Firebase Storage / Fragrantica images,
  # data:/blob: images (canvas + PWA), the Python fragrance engine for direct
  # browser calls, and same-origin everything else. frame-ancestors mirrors
  # X-Frame-Options: DENY.
  csp_value = join("; ", concat([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: ${join(" ", var.csp_img_origins)}",
    "connect-src 'self' ${join(" ", var.csp_connect_origins)}",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ],
    # Violation reporting — the pre-flip requirement for csp_enforce. Without a
    # report-uri, Report-Only violations are visible only in end users' consoles
    # and the "violation-free week" bake can never be observed.
    var.csp_report_uri == "" ? [] : ["report-uri ${var.csp_report_uri}"],
  ))
}

# /assets/* : public, max-age=31536000, immutable
resource "aws_cloudfront_response_headers_policy" "immutable_assets" {
  name    = "scast-immutable-assets"
  comment = "Cache-Control: public, max-age=31536000, immutable (content-hashed /assets/*)"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = true
    }
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

# /nav /icons /social /beta /favicon.svg + OG images :
#   public, max-age=86400, stale-while-revalidate=604800  (browser)
#   CDN keeps them 1yr via the static_long cache policy.
resource "aws_cloudfront_response_headers_policy" "browser_short" {
  name    = "scast-browser-short-cdn-long"
  comment = "Cache-Control: public, max-age=86400, stale-while-revalidate=604800 (browser); CDN caches 1yr"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=86400, stale-while-revalidate=604800"
      override = true
    }
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

# index.html / SPA shell / manifest / community / arena / debug / share :
#   no-cache, max-age=0, must-revalidate
resource "aws_cloudfront_response_headers_policy" "no_cache_html" {
  name    = "scast-no-cache-html"
  comment = "Cache-Control: no-cache, max-age=0, must-revalidate (HTML shell, manifest, dynamic routes)"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "no-cache, max-age=0, must-revalidate"
      override = true
    }
    items {
      # Documents only (this policy serves the HTML shell): lock down the
      # powerful browser features the app never uses. geolocation stays
      # self-allowed — WeatherContext.tsx uses it for local weather.
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(self)"
      override = true
    }
    items {
      # Staged CSP — see the banner comment above. Report-Only until
      # csp_enforce is flipped after a clean bake period.
      header   = var.csp_enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"
      value    = local.csp_value
      override = true
    }
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

###############################################################################
# Distribution
###############################################################################
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "sCAST SPA (S3 + /api proxy to Railway)"
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class
  aliases             = local.aliases

  # --- Origin 1: private S3 bucket via OAC -----------------------------------
  origin {
    origin_id                = "s3-frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  # --- Origin 2: Railway Express backend (custom origin, HTTPS-only) ----------
  origin {
    origin_id   = "railway-backend"
    domain_name = var.backend_origin_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # --- Default behavior: SPA shell / unmatched routes -> S3, no-cache ---------
  # Unmatched client-side routes 404 at S3 and are rewritten to index.html by the
  # custom_error_response blocks below, so the default response must be no-cache.
  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.no_cache_html.id
  }

  # --- /api/* -> Railway backend, no cache, forward everything ----------------
  # This is the CloudFront replacement for middleware.js. CachingDisabled + the
  # AllViewerExceptHostHeader origin-request policy forward the Authorization
  # header, cookies, and query strings straight through to Railway.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "railway-backend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  # --- /assets/* -> S3, immutable 1yr ----------------------------------------
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.static_long.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.immutable_assets.id
  }

  # --- Browser-cached static dirs & files -> S3 (1 day browser / 1 yr CDN) ----
  # Same policy pair for each; wildcards for dirs, exact patterns for named files.
  dynamic "ordered_cache_behavior" {
    for_each = toset([
      "/nav/*",
      "/icons/*",
      "/social/*",
      "/beta/*",
      "/favicon.svg",
      "/opengraph-scentbeam-v2.png",
      "/opengraph.jpg",
      "/scent-concierge-avatar.png",
    ])

    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "s3-frontend"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      cache_policy_id            = aws_cloudfront_cache_policy.static_long.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.browser_short.id
    }
  }

  # --- SPA routing: 403/404 from S3 -> index.html with HTTP 200 ---------------
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # --- TLS -------------------------------------------------------------------
  # Custom domain -> ACM cert (SNI, TLSv1.2_2021 floor).
  # No domain      -> default *.cloudfront.net cert.
  viewer_certificate {
    cloudfront_default_certificate = local.acm_certificate_arn == null ? true : null
    acm_certificate_arn            = local.acm_certificate_arn
    ssl_support_method             = local.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = local.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }
}

###############################################################################
# ACM certificate (us-east-1) — only when a custom domain is configured
#
# domain_name == ""  -> no cert, no aliases; CloudFront serves its default
#                       *.cloudfront.net domain + certificate.
# domain_name != ""  -> request a DNS-validated cert in us-east-1.
#     - route53_zone_id set   : validation records + validation wait are fully
#                               automated, and an alias record is created below.
#     - route53_zone_id empty : create the validation CNAMEs in your external DNS
#                               by hand (see README), then re-run `terraform apply`.
###############################################################################

locals {
  use_custom_domain = trimspace(var.domain_name) != ""
  use_route53       = local.use_custom_domain && trimspace(var.route53_zone_id) != ""
  aliases           = local.use_custom_domain ? concat([var.domain_name], var.alternate_domain_names) : []

  # Prefer the validated ARN (route53 auto path); otherwise the raw cert ARN
  # (manual DNS path); null when no custom domain (use default CF cert).
  acm_certificate_arn = local.use_route53 ? one(aws_acm_certificate_validation.frontend[*].certificate_arn) : (
    local.use_custom_domain ? one(aws_acm_certificate.frontend[*].arn) : null
  )
}

resource "aws_acm_certificate" "frontend" {
  count = local.use_custom_domain ? 1 : 0

  domain_name               = var.domain_name
  subject_alternative_names = var.alternate_domain_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# --- Route53 automated validation path (only when route53_zone_id is set) -----
resource "aws_route53_record" "cert_validation" {
  for_each = local.use_route53 ? {
    for dvo in aws_acm_certificate.frontend[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "frontend" {
  count = local.use_route53 ? 1 : 0

  certificate_arn         = aws_acm_certificate.frontend[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- Optional Route53 alias pointing the domain at CloudFront ------------------
resource "aws_route53_record" "frontend_alias_a" {
  count = local.use_route53 ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "frontend_alias_aaaa" {
  count = local.use_route53 ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

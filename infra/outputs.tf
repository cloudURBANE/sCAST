###############################################################################
# Outputs — wire these into GitHub Actions secrets/vars (see README).
# Exact names required by the migration contract; do not rename.
###############################################################################

output "frontend_bucket_name" {
  description = "S3 bucket holding the built SPA. -> GitHub Actions variable FRONTEND_S3_BUCKET."
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID. -> GitHub Actions variable CLOUDFRONT_DISTRIBUTION_ID (used for invalidations)."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "CloudFront default domain (*.cloudfront.net). Point DNS here at cutover / smoke-test against it."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "github_actions_role_arn" {
  description = "IAM role ARN assumed by GitHub Actions via OIDC. -> GitHub Actions secret AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_actions_frontend_deploy.arn
}

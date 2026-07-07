###############################################################################
# GitHub Actions OIDC -> IAM role (no long-lived AWS keys anywhere)
#
# GitHub Actions presents a short-lived OIDC token; this role's trust policy
# accepts it only for the configured repo + refs and only for the AWS STS
# audience. The permission policy is least-privilege: exactly what the deploy
# workflow needs (sync to the one bucket + invalidate the one distribution).
###############################################################################

# --- OIDC provider for GitHub Actions ----------------------------------------
# The thumbprints below are GitHub's well-known intermediate CA thumbprints.
# AWS no longer relies on them for this well-known IdP, but the argument is kept
# for provider compatibility across versions.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fca",
  ]
}

# --- Trust policy: this repo + allowed refs, AWS STS audience -----------------
data "aws_iam_policy_document" "github_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        for ref in var.github_deploy_refs :
        "repo:${var.github_owner}/${var.github_repo}:ref:${ref}"
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_frontend_deploy" {
  name               = "github_actions_frontend_deploy"
  description        = "Assumed by GitHub Actions (OIDC) to deploy the sCAST SPA to S3 + invalidate CloudFront"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

# --- Least-privilege permission policy ---------------------------------------
data "aws_iam_policy_document" "github_deploy_permissions" {
  # List objects on the bucket (needed for `aws s3 sync --delete`).
  statement {
    sid       = "ListFrontendBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]
  }

  # Upload / delete objects during sync.
  statement {
    sid       = "WriteFrontendObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }

  # Invalidate the no-cache HTML entry points after a deploy.
  statement {
    sid       = "InvalidateDistribution"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.frontend.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy_permissions" {
  name   = "frontend-deploy-least-privilege"
  role   = aws_iam_role.github_actions_frontend_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_permissions.json
}

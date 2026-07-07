###############################################################################
# S3 — private origin bucket for the built SPA
#
# The bucket is fully private: all public access is blocked and the ONLY reader
# is the CloudFront distribution, authorised through an Origin Access Control
# (OAC) + a bucket policy scoped to this distribution's ARN. There is no website
# endpoint and no public ACL.
###############################################################################

resource "aws_s3_bucket" "frontend" {
  bucket = var.frontend_bucket_name
}

# Disable ACLs entirely; bucket is owned by us and served via OAC.
resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Block every avenue of public access.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Encrypt objects at rest with SSE-S3 (default managed keys).
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Bucket policy: allow ONLY the CloudFront distribution (via OAC) to read objects.
data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid     = "AllowCloudFrontServicePrincipalReadOnly"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json

  # Ensure the public-access-block is in place before the policy is evaluated.
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

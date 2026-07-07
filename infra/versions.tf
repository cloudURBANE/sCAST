###############################################################################
# Terraform + provider version constraints
#
# CloudFront's ACM certificate MUST live in us-east-1, and we keep ALL resources
# in us-east-1 to stay simple (see MIGRATION_CONTRACT.md "Region: us-east-1
# everywhere"). The single aws provider below is therefore pinned to us-east-1.
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state (S3 + DynamoDB) — COMMENTED OUT so `terraform init` works out of
  # the box with local state. To adopt shared remote state, see infra/README.md
  # ("Remote state") for the one-time bootstrap, then uncomment this block and run
  # `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket         = "scentbeam-terraform-state"   # pre-created, versioned, private
  #   key            = "scast/frontend/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "scentbeam-terraform-locks"   # pre-created, PK = LockID (String)
  #   encrypt        = true
  # }
  # ---------------------------------------------------------------------------
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

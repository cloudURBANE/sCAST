-- Catches the journal up to the bearer-token hardening (C1/C2) that already
-- shipped by hand as supabase/migrations/20260707120000_user_token_hash_and_expiry.sql.
-- Additive/nullable, so this is a no-op ADD COLUMN IF NOT EXISTS-equivalent on any
-- database where that hand migration already ran (drizzle-kit generate does not
-- emit IF NOT EXISTS, so re-running this file on such a database will error on the
-- duplicate column — that database should adopt the journal via `migrate:stamp`
-- instead of applying this file; see lib/db/migrations/pre-baseline/README.md).
ALTER TABLE "users" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_issued_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_last_used_at" timestamp;--> statement-breakpoint
CREATE INDEX "users_token_hash_idx" ON "users" USING btree ("token_hash");
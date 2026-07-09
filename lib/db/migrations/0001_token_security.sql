-- C1/C2 token security columns (may already exist on deployments that ran
-- drizzle-kit push before the migration workflow landed — hence IF NOT EXISTS).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_issued_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_last_used_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_token_hash_idx" ON "users" USING btree ("token_hash");
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "user_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tokens_user_id_idx" ON "user_tokens" USING btree ("user_id");--> statement-breakpoint
-- Backfill (S2/S9): carry every existing login over as a session row so nobody
-- is logged out by this migration. Hash is taken from token_hash when stamped,
-- else computed from the still-plaintext token; issued_at is coalesced to now()
-- so the C2 expiry policy covers legacy NULL rows within one TTL window (S9).
INSERT INTO "user_tokens" ("user_id", "token_hash", "issued_at", "last_used_at")
SELECT "id",
       COALESCE("token_hash", encode(sha256(convert_to("token"::text, 'UTF8')), 'hex')),
       COALESCE("token_issued_at", now()),
       "token_last_used_at"
FROM "users"
WHERE "token" IS NOT NULL
ON CONFLICT ON CONSTRAINT "user_tokens_token_hash_unique" DO NOTHING;--> statement-breakpoint
-- Scrub the plaintext credential (S2/C1): overwrite users.token with fresh
-- random UUIDs that correspond to no live session, so a dump of this table is
-- no longer an account-takeover artifact. users.token_hash is left in place —
-- it is not reversible and a pre-S2 instance authenticates against it during
-- the rolling deploy. The whole legacy column set (token, token_hash,
-- token_issued_at, token_last_used_at + users_token_idx/users_token_hash_idx)
-- is dropped by a follow-up contraction migration once no deployed code
-- references it.
UPDATE "users" SET "token" = gen_random_uuid();

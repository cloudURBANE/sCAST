CREATE TABLE "user_fragrance_with_me" (
	"user_fragrance_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "with_me_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "with_me_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_fragrance_with_me" ADD CONSTRAINT "user_fragrance_with_me_user_fragrance_id_user_fragrances_id_fk" FOREIGN KEY ("user_fragrance_id") REFERENCES "public"."user_fragrances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_fragrance_with_me" ADD CONSTRAINT "user_fragrance_with_me_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_fragrance_with_me" ADD CONSTRAINT "user_fragrance_with_me_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_fragrance_with_me_tenant_user_idx" ON "user_fragrance_with_me" USING btree ("tenant_id","user_id");
CREATE TABLE "beam_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "beam_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "beam_conversations" ADD CONSTRAINT "beam_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beam_conversations" ADD CONSTRAINT "beam_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beam_messages" ADD CONSTRAINT "beam_messages_conversation_id_beam_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."beam_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beam_messages" ADD CONSTRAINT "beam_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beam_messages" ADD CONSTRAINT "beam_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "beam_conversations_user_session_idx" ON "beam_conversations" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "beam_conversations_user_updated_idx" ON "beam_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "beam_messages_conversation_seq_idx" ON "beam_messages" USING btree ("conversation_id","seq");
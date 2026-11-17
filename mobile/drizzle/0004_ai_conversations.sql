CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ai_messages_user_idx";--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
-- Messages from before chats existed become one chat per user, titled by their first question.
INSERT INTO "ai_conversations" ("user_id", "title", "created_at", "updated_at")
SELECT m."user_id",
  COALESCE(LEFT((SELECT f."content" FROM "ai_messages" f WHERE f."user_id" = m."user_id" AND f."role" = 'user' ORDER BY f."created_at" LIMIT 1), 60), 'Earlier chat'),
  MIN(m."created_at"), MAX(m."created_at")
FROM "ai_messages" m GROUP BY m."user_id";--> statement-breakpoint
UPDATE "ai_messages" m SET "conversation_id" = c."id" FROM "ai_conversations" c WHERE c."user_id" = m."user_id";--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");
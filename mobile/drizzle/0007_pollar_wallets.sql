CREATE TABLE "user_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"xdr" text NOT NULL,
	"hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"request_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pollar_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_txs" ADD CONSTRAINT "user_txs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_txs_user_idx" ON "user_txs" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pollar_user_id_unique" UNIQUE("pollar_user_id");--> statement-breakpoint
-- Accounts from before Pollar already got their welcome money with their (Tappi-held) wallet.
UPDATE "users" SET "welcomed_at" = "created_at" WHERE "id" IN (SELECT "user_id" FROM "wallets");

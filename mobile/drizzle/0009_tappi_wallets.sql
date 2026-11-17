-- Back to wallets Tappi holds itself (no Pollar): email codes and encrypted wallet keys return.
CREATE TABLE "login_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Every wallet so far is either a Pollar wallet or had its key dropped in 0008: Tappi can't sign
-- for any of them, so those (testnet) accounts start again.
DELETE FROM "users" WHERE "pollar_user_id" IS NOT NULL OR "id" IN (SELECT "user_id" FROM "wallets");--> statement-breakpoint
DROP TABLE "user_txs" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_pollar_user_id_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "pollar_user_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "welcomed_at";--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "encrypted_secret" text;

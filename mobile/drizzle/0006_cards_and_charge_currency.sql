CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"number" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"cvv" text NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"daily_limit" numeric(20, 7) DEFAULT 100000 NOT NULL,
	"funding_asset" text DEFAULT 'NGN' NOT NULL,
	"armed_nonce" text,
	"armed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "asset" text DEFAULT 'NGN' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
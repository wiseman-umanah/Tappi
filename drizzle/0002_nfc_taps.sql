ALTER TABLE "payment_requests" ADD COLUMN "tapped_by" uuid;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "tapped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD COLUMN "card_brand" text;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_tapped_by_users_id_fk" FOREIGN KEY ("tapped_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
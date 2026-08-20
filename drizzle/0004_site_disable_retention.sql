ALTER TABLE "site" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "retention_limit" integer;
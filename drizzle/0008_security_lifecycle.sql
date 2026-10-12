ALTER TABLE "site" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_id_site_key" ON "deployment" USING btree ("id","site_id");--> statement-breakpoint
UPDATE "site" SET "active_deployment_id" = NULL WHERE "active_deployment_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "deployment" WHERE "deployment"."id" = "site"."active_deployment_id" AND "deployment"."site_id" = "site"."id");--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_active_deployment_fk" FOREIGN KEY ("active_deployment_id","id") REFERENCES "public"."deployment"("id","site_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "deployment" SET "status" = 'cleanup_pending' WHERE "status" = 'failed';

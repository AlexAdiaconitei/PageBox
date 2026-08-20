ALTER TABLE "user" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "group" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group" ADD CONSTRAINT "group_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_created_by_idx" ON "user" USING btree ("created_by_user_id");--> statement-breakpoint
-- An instance built under the two-role model can hold several superadmins, and the index
-- below would refuse to build over them. The oldest one keeps the seat — it is the account
-- the instance was bootstrapped with — and the rest become admins, which is the tier that
-- now describes what they were actually doing: their own sites and their own accounts.
UPDATE "user" SET "role" = 'admin'
WHERE "role" = 'superadmin'
  AND "id" <> (
    SELECT "id" FROM "user" WHERE "role" = 'superadmin' ORDER BY "created_at", "id" LIMIT 1
  );--> statement-breakpoint
-- Accounts an admin created before this column existed cannot be attributed, so they stay
-- null and remain the superadmin's to administer. Nothing is guessed from what is there.
CREATE UNIQUE INDEX "user_single_superadmin" ON "user" USING btree ("role") WHERE role = 'superadmin';--> statement-breakpoint
CREATE INDEX "group_owner_idx" ON "group" USING btree ("owner_user_id");
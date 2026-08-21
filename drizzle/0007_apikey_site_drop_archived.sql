ALTER TABLE "apikey" ADD COLUMN "site_id" text;--> statement-breakpoint
-- Backfill from the metadata the plugin already stores. Guarded on the text looking like
-- an object, because `metadata` is a free-text column and a bad cast would fail the whole
-- migration over a row nothing reads.
UPDATE "apikey"
SET "site_id" = ("metadata"::jsonb ->> 'siteId')
WHERE "metadata" IS NOT NULL AND "metadata" ~ '^\s*\{';--> statement-breakpoint
CREATE INDEX "apikey_site_idx" ON "apikey" USING btree ("site_id");--> statement-breakpoint
-- `archived_at` was in the schema from the first migration and nothing ever wrote to it:
-- four code paths guarded against a state that could not occur. Disabling a site (0004)
-- covers taking one off the air and deleting covers retiring it, so the column is dropped
-- rather than left as a promise. Every value in it is null by construction.
--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "archived_at";
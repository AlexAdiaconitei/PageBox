CREATE TABLE "site_session" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"site_id" text NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_authorization" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"session_id" text NOT NULL,
	"next_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_session" ADD CONSTRAINT "site_session_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_session" ADD CONSTRAINT "site_session_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_authorization" ADD CONSTRAINT "site_authorization_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_authorization" ADD CONSTRAINT "site_authorization_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_session_token_key" ON "site_session" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "site_session_parent_site_key" ON "site_session" USING btree ("session_id","site_id");--> statement-breakpoint
CREATE INDEX "site_session_expires_idx" ON "site_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "site_authorization_parent_idx" ON "site_authorization" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "site_authorization_expires_idx" ON "site_authorization" USING btree ("expires_at");

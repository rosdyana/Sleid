CREATE TABLE "user_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "logo_dark_key" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "logo_dark_mime" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "logo_dark_bytes" integer;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "logo_dark_sha256" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "footer_text" text;--> statement-breakpoint
ALTER TABLE "user_assets" ADD CONSTRAINT "user_assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_assets_owner_idx" ON "user_assets" USING btree ("owner_id");
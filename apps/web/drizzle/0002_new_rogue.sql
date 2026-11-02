CREATE TYPE "public"."export_format" AS ENUM('pdf', 'png', 'jpg', 'pptx', 'html', 'markdown', 'json');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"format" "export_format" NOT NULL,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"file_key" text,
	"file_name" text,
	"content_type" text,
	"bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "published_token" text;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "published_indexable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_deck_id_idx" ON "assets" USING btree ("deck_id");--> statement-breakpoint
CREATE INDEX "exports_user_id_idx" ON "exports" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_published_token_unique" UNIQUE("published_token");
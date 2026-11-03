CREATE TYPE "public"."wizard_source_kind" AS ENUM('file', 'url', 'search');--> statement-breakpoint
CREATE TYPE "public"."wizard_source_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."wizard_status" AS ENUM('draft', 'ingesting', 'outlining', 'ready', 'generating', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "wizard_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"deck_id" uuid,
	"brief" jsonb NOT NULL,
	"outline" jsonb,
	"status" "wizard_status" DEFAULT 'draft' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wizard_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "wizard_source_kind" NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"file_name" text,
	"mime" text,
	"file_key" text,
	"status" "wizard_source_status" DEFAULT 'queued' NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"extracted" jsonb,
	"error" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wizard_runs" ADD CONSTRAINT "wizard_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wizard_runs" ADD CONSTRAINT "wizard_runs_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wizard_sources" ADD CONSTRAINT "wizard_sources_run_id_wizard_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."wizard_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wizard_runs_user_idx" ON "wizard_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wizard_runs_deck_idx" ON "wizard_runs" USING btree ("deck_id");--> statement-breakpoint
CREATE INDEX "wizard_sources_run_idx" ON "wizard_sources" USING btree ("run_id","position");
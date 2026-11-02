CREATE TYPE "public"."llm_provider_kind" AS ENUM('foundry-claude', 'azure-openai', 'openai-compatible');--> statement-breakpoint
CREATE TYPE "public"."llm_scope" AS ENUM('user', 'workspace');--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "llm_scope" NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"kind" "llm_provider_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ciphertext" text,
	"default_model" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"deck_id" uuid NOT NULL,
	"provider_id" uuid,
	"ability" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_providers_owner_idx" ON "llm_providers" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_one_default_per_user" ON "llm_providers" USING btree ("owner_id") WHERE "llm_providers"."is_default" and "llm_providers"."scope" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_one_default_workspace" ON "llm_providers" USING btree ("scope") WHERE "llm_providers"."is_default" and "llm_providers"."scope" = 'workspace';--> statement-breakpoint
CREATE INDEX "llm_usage_user_created_idx" ON "llm_usage" USING btree ("user_id","created_at");
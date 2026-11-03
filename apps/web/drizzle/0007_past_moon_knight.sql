ALTER TABLE "llm_usage" ALTER COLUMN "deck_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wizard_sources" ADD COLUMN "bytes" integer;
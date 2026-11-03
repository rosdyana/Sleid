ALTER TABLE "deck_members" ADD COLUMN "starred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Data copy (hand-edited): every member of a starred deck inherits the star. Before M2 only
-- owners existed, so this is the owner's star, carried over unchanged.
UPDATE "deck_members" SET "starred" = true FROM "decks" WHERE "decks"."id" = "deck_members"."deck_id" AND "decks"."starred";--> statement-breakpoint
ALTER TABLE "decks" DROP COLUMN "starred";
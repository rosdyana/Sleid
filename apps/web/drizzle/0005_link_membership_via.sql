CREATE TYPE "public"."member_via" AS ENUM('owner', 'invite', 'link');--> statement-breakpoint
ALTER TABLE "deck_members" ADD COLUMN "via" "member_via" DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "deck_members" ADD COLUMN "share_link_id" uuid;--> statement-breakpoint
ALTER TABLE "deck_members" ADD CONSTRAINT "deck_members_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill. Owners are 'owner'. Every other existing membership stays 'invite', including people who may have
-- joined through a link: the database cannot tell those apart, and 'invite' is the conservative choice (a restricted
-- link does not remove them). Owners can remove them by hand.
UPDATE "deck_members" SET "via" = 'owner' WHERE "role" = 'owner';

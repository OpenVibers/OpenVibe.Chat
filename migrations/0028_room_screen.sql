-- phase: expand
-- A workspace room's shared screen (owner 2026-10-25: a screen the group watches and uses together): a screen share
-- link from OpenVibe.Bot (https://openvibe.bot/screen/<token>, made by the computer's owner), shown beside the
-- conversation to the room's members only. The link is a key to that screen, so only members ever see it.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS screen_url text;

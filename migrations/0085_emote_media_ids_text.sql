-- phase: expand
-- An emote's OpenVibe.Media id is text: Media's objects are "med_01M7VG159AD2EEPX4NV36V45H9" (the old assets were
-- numbers). The column was bigint, so every emote upload since Chat stored the new ids failed (11-20, production:
-- "invalid input syntax for type bigint", four uploads in one session). The 41 numeric ids stay, as text; code that
-- reads the column treats it as an opaque id (media.deleteObject). channel_sounds.media_asset_id stays bigint: it is
-- written only by Live's asset sync (chat.sound-asset-request@1, an integer).
ALTER TABLE emotes ALTER COLUMN media_asset_id TYPE text USING media_asset_id::text;

-- Migration 002: store the original command payload (spec §7.4).
--
-- command.retry_indeterminate must re-dispatch the ORIGINAL message with the
-- ORIGINAL requestId (the transcript user UUID) and the ORIGINAL payload
-- text; a fresh UUID would create a duplicate user record in the transcript.
-- The canonical payload JSON is stored at acceptance time. Pre-migration
-- rows keep the default '' (no re-dispatch possible for them).
ALTER TABLE commands ADD COLUMN payloadJson TEXT NOT NULL DEFAULT '';

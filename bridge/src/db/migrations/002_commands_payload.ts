/**
 * Migration 002: commands.payloadJson (spec §7.4).
 *
 * Stores the canonical JSON of the accepted command payload so
 * command.retry_indeterminate can re-dispatch the ORIGINAL message (original
 * requestId UUID + original payload text). The .sql file with the identical
 * content lives alongside for review.
 */
export const MIGRATION_002_SQL = `
ALTER TABLE commands ADD COLUMN payloadJson TEXT NOT NULL DEFAULT '';
`;

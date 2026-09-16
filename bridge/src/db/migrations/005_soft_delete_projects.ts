/**
 * Migration 005: soft delete projects.
 *
 * Add revokedAt column to projects table so revocation doesn't fail when
 * the project has associated sessions. This aligns with the devices table
 * design and preserves audit trails.
 */
export const MIGRATION_005_SQL = `
ALTER TABLE projects ADD COLUMN revokedAt INTEGER;

CREATE INDEX idx_projects_revoked ON projects(revokedAt);
`;

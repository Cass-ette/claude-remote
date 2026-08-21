-- Initial schema for the Bridge SQLite database.
--
-- This file is the human-readable source of truth. The runtime uses the
-- identical SQL embedded in 001_initial.ts (verified by a test) so the
-- built output in dist/ has no filesystem dependency on this file.

CREATE TABLE projects (
  projectId            TEXT PRIMARY KEY,
  canonicalRealpath    TEXT NOT NULL UNIQUE,
  deviceNumber         INTEGER NOT NULL,
  inode                INTEGER NOT NULL,
  displayName          TEXT NOT NULL,
  createdAt            INTEGER NOT NULL,
  authorizedAt         INTEGER NOT NULL
);

CREATE TABLE sessions (
  sessionId            TEXT PRIMARY KEY,
  projectId            TEXT NOT NULL REFERENCES projects(projectId),
  displayName          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
    'inactive','starting','idle','running','waiting_permission',
    'interrupting','releasing','interrupted','failed'
  )),
  source               TEXT NOT NULL CHECK (source IN ('bridge','imported')),
  lastClaudeVersion    TEXT,
  lastEventId          INTEGER NOT NULL DEFAULT 0,
  lastActivityAt       INTEGER NOT NULL,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE commands (
  requestId            TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL,
  sessionId            TEXT NOT NULL,
  idempotencyKey       TEXT NOT NULL,
  commandType          TEXT NOT NULL,
  payloadHash          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
    'accepted','dispatching','dispatched',
    'indeterminate','interrupted','completed','failed'
  )),
  resultJson           TEXT,
  createdAt            INTEGER NOT NULL,
  updatedAt            INTEGER NOT NULL,
  UNIQUE (deviceId, idempotencyKey)
);
CREATE INDEX idx_commands_session ON commands(sessionId);

CREATE TABLE pending_events (
  sessionId            TEXT NOT NULL,
  eventId              INTEGER NOT NULL,
  eventType            TEXT NOT NULL,
  payloadJson          TEXT NOT NULL,
  protocolVersion      TEXT NOT NULL,
  deleteAfter          INTEGER,
  createdAt            INTEGER NOT NULL,
  PRIMARY KEY (sessionId, eventId)
);

CREATE TABLE device_delivery (
  deviceId             TEXT NOT NULL,
  sessionId            TEXT NOT NULL,
  protocolVersion      TEXT NOT NULL,
  deliveryBase         INTEGER NOT NULL,
  deliveryWatermark    INTEGER NOT NULL,
  deliveryCheckpointWatermark INTEGER NOT NULL DEFAULT 0,
  pendingCheckpoint    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deviceId, sessionId)
);

CREATE TABLE history_snapshots (
  snapshotId           TEXT PRIMARY KEY,
  sessionId            TEXT NOT NULL,
  deviceId             TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('prepared','committed','expired')),
  historyRevision      TEXT NOT NULL,
  adapterVersion       TEXT NOT NULL,
  transcriptPath       TEXT NOT NULL,
  readByteLimit        INTEGER NOT NULL,
  deliveryBase         INTEGER NOT NULL,
  deliveryWatermark    INTEGER NOT NULL,
  sessionStatus        TEXT NOT NULL,
  pendingPermissionJson TEXT,
  commitIdempotencyKey TEXT,
  commitResultJson     TEXT,
  committedAt          INTEGER,
  createdAt            INTEGER NOT NULL,
  expiresAt            INTEGER NOT NULL
);

CREATE TABLE history_snapshot_items (
  snapshotId           TEXT NOT NULL REFERENCES history_snapshots(snapshotId),
  ordinal              INTEGER NOT NULL,
  historyItemId        TEXT NOT NULL,
  historyRevision      TEXT NOT NULL,
  payloadJson          TEXT NOT NULL,
  PRIMARY KEY (snapshotId, ordinal)
);

CREATE TABLE session_locks (
  sessionId            TEXT PRIMARY KEY,
  bridgeInstanceId     TEXT NOT NULL,
  processLeaseSecret   TEXT,
  processPid           INTEGER,
  processStartedAt     INTEGER,
  heartbeatAt          INTEGER NOT NULL
);

CREATE TABLE devices (
  deviceId             TEXT PRIMARY KEY,
  publicKeySpki        TEXT NOT NULL,
  accessSubject        TEXT NOT NULL,
  displayName          TEXT NOT NULL,
  pairedAt             INTEGER NOT NULL,
  revokedAt            INTEGER
);

CREATE TABLE device_sessions (
  tokenHash            TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL REFERENCES devices(deviceId),
  accessSubject        TEXT NOT NULL,
  expiresAt            INTEGER NOT NULL,
  revokedAt            INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE pairing_tokens (
  tokenHash            TEXT PRIMARY KEY,
  expiresAt            INTEGER NOT NULL,
  consumedAt           INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE auth_challenges (
  challengeId          TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL,
  accessSubject        TEXT NOT NULL,
  hostAscii            TEXT NOT NULL,
  challengeRaw         BLOB NOT NULL,
  expiresAt            INTEGER NOT NULL,
  consumedAt           INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE audit_events (
  auditId              INTEGER PRIMARY KEY AUTOINCREMENT,
  occurredAt           INTEGER NOT NULL,
  accessSubjectHash    TEXT,
  deviceId             TEXT,
  rayId                TEXT,
  sourceIp             TEXT,
  requestId            TEXT,
  operationType        TEXT NOT NULL,
  sessionId            TEXT,
  projectId            TEXT,
  resultCode           TEXT NOT NULL,
  toolCategory         TEXT,
  permissionDecision   TEXT,
  redactedDetail       TEXT
);

-- schema_migrations is created by migrate() itself before any migration
-- runs, so it is deliberately not part of this migration body.

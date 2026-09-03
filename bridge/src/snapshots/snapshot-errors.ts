/**
 * Typed snapshot/checkpoint protocol errors (spec §6.7).
 *
 * Each error carries a stable machine-readable `code` and the HTTP status
 * the protocol layer (Task 24 wiring) must map it to:
 *   - SNAPSHOT_EXPIRED          → 410
 *   - CHECKPOINT_COMMIT_REQUIRED → 409
 *   - CHECKPOINT_CONFLICT        → 409
 *   - SNAPSHOT_FORBIDDEN         → 403
 *
 * Kept in a dedicated module so the event journal (the ACK delivery path)
 * can throw the 409 guard error without depending on the snapshot service
 * itself.
 */

export class SnapshotProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Cursor or snapshot no longer valid (expired, unknown, or already consumed); the client must re-begin. */
export class SnapshotExpiredError extends SnapshotProtocolError {
  constructor(detail: string) {
    super(`SNAPSHOT_EXPIRED: ${detail}`, "SNAPSHOT_EXPIRED", 410);
  }
}

/**
 * An ordinary events.ack would move delivery past `deliveryBase` while a
 * prepared snapshot exists for the device; the checkpoint must be
 * committed (or expire) first.
 */
export class CheckpointCommitRequiredError extends SnapshotProtocolError {
  constructor(readonly deviceId: string, readonly sessionId: string, readonly eventId: bigint, readonly deliveryBase: number) {
    super(
      `CHECKPOINT_COMMIT_REQUIRED: device ${deviceId} acknowledged ${sessionId} event ${eventId}, beyond ` +
        `deliveryBase ${deliveryBase} while a prepared snapshot exists; commit the checkpoint first`,
      "CHECKPOINT_COMMIT_REQUIRED",
      409,
    );
  }
}

/** Commit fields (idempotency key / historyRevision / watermark) conflict with the snapshot row. */
export class CheckpointConflictError extends SnapshotProtocolError {
  constructor(detail: string) {
    super(`CHECKPOINT_CONFLICT: ${detail}`, "CHECKPOINT_CONFLICT", 409);
  }
}

/** The snapshot belongs to a different device. */
export class SnapshotForbiddenError extends SnapshotProtocolError {
  constructor(readonly snapshotId: string, readonly ownerDeviceId: string, readonly deviceId: string) {
    super(
      `SNAPSHOT_FORBIDDEN: snapshot ${snapshotId} belongs to device ${ownerDeviceId}, not ${deviceId}`,
      "SNAPSHOT_FORBIDDEN",
      403,
    );
  }
}

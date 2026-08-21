/**
 * Protocol v1 TypeScript models, mirroring contracts/v1/*.schema.json.
 * The JSON Schemas are the cross-language source of truth (Task 26 mirrors
 * them in Kotlin); these types exist for type-safe bridge code.
 */

export const PROTOCOL_VERSION = "claude-remote.v1";

/** Decimal-stringified unsigned 64-bit integer, e.g. "18446744073709551615". */
export type Uint64String = string;

export const COMMAND_TYPES = [
  "session.list",
  "session.scan_imports",
  "session.import",
  "session.create",
  "session.resume",
  "session.stop",
  "session.release",
  "session.state.get",
  "session.snapshot.begin",
  "session.snapshot.page",
  "session.snapshot.commit",
  "message.send",
  "command.cancel",
  "command.retry_indeterminate",
  "permission.resolve",
  "events.ack",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const EVENT_TYPES = [
  "session.state.changed",
  "command.status.changed",
  "assistant.message.delta",
  "assistant.message.completed",
  "tool.started",
  "tool.output.delta",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "process.stderr.summary",
  "session.interrupted",
  "session.failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const COMMAND_STATUSES = [
  "accepted",
  "dispatching",
  "dispatched",
  "indeterminate",
  "interrupted",
  "completed",
  "failed",
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

// ---------------------------------------------------------------------------
// Command payloads (discriminated on commandType)
// ---------------------------------------------------------------------------

export interface SessionListPayload {
  readonly projectId?: undefined;
}

export interface SessionScanImportsPayload {
  readonly projectId: string;
}

export interface SessionImportPayload {
  readonly sessionId: string;
  readonly projectId: string;
}

export interface SessionCreatePayload {
  readonly projectId: string;
  readonly displayName?: string;
}

export interface SessionRefPayload {
  readonly sessionId: string;
}

export interface SessionSnapshotPagePayload {
  readonly sessionId: string;
  readonly cursor: string;
}

export interface SessionSnapshotCommitPayload {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly historyRevision: string;
  readonly deliveryWatermark: Uint64String;
  readonly idempotencyKey: string;
}

export interface MessageSendPayload {
  readonly sessionId: string;
  readonly text: string;
}

export interface CommandRefPayload {
  readonly requestId: string;
}

export interface PermissionResolvePayload {
  readonly permissionRequestId: string;
  readonly sessionId: string;
  readonly decision: "allow" | "deny";
}

export interface EventsAckPayload {
  readonly sessionId: string;
  readonly lastEventId: Uint64String;
}

export interface CommandEnvelopeMap {
  readonly "session.list": SessionListPayload;
  readonly "session.scan_imports": SessionScanImportsPayload;
  readonly "session.import": SessionImportPayload;
  readonly "session.create": SessionCreatePayload;
  readonly "session.resume": SessionRefPayload;
  readonly "session.stop": SessionRefPayload;
  readonly "session.release": SessionRefPayload;
  readonly "session.state.get": SessionRefPayload;
  readonly "session.snapshot.begin": SessionRefPayload;
  readonly "session.snapshot.page": SessionSnapshotPagePayload;
  readonly "session.snapshot.commit": SessionSnapshotCommitPayload;
  readonly "message.send": MessageSendPayload;
  readonly "command.cancel": CommandRefPayload;
  readonly "command.retry_indeterminate": CommandRefPayload;
  readonly "permission.resolve": PermissionResolvePayload;
  readonly "events.ack": EventsAckPayload;
}

export interface Command<T extends CommandType = CommandType> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly commandType: T;
  /** null for global commands. */
  readonly sessionId: string | null;
  readonly sentAt: string;
  readonly payload: CommandEnvelopeMap[T];
}

// ---------------------------------------------------------------------------
// Response (§8.3)
// ---------------------------------------------------------------------------

export interface ResponseError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export type CommandStatusResponse = {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly responseType: "command.status";
  readonly commandStatus: CommandStatus;
  readonly result?: unknown;
};

export type CommandErrorResponse = {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly responseType: "command.error";
  readonly error: ResponseError;
};

export type ProtocolResponse = CommandStatusResponse | CommandErrorResponse;

// ---------------------------------------------------------------------------
// Event (§8.4)
// ---------------------------------------------------------------------------

export interface CommandStatusChangedPayload {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly commandStatus: CommandStatus;
  readonly result?: unknown;
  readonly error?: ResponseError;
}

/** Event payloads other than command.status.changed stay loose until Chunk 3. */
export type EventPayload = Record<string, unknown>;

export interface ProtocolEvent {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  /** Decimal string; use parseEventId() to get the bigint value. */
  readonly eventId: Uint64String;
  readonly sessionId: string;
  readonly eventType: EventType;
  readonly timestamp: string;
  readonly payload: EventPayload;
}

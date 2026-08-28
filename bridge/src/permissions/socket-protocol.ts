/**
 * Permission broker socket protocol (spec §6.4, Task 17).
 *
 * The permission MCP adapter (Task 18) talks to the Bridge's permission
 * broker over a Unix domain socket owned by the Bridge data dir (path handed
 * to the Claude child via the `BRIDGE_PERMISSION_SOCKET` env var, file mode
 * 0600). Frames are length-prefixed JSON:
 *
 *     <4-byte big-endian payload length><UTF-8 JSON payload>
 *
 * Frame set (minimal by design; every frame is documented here):
 *
 * Adapter → Broker
 *   hello             { type, leaseSecret, sessionId }
 *                     First frame on the connection. The 256-bit lease
 *                     secret is single-use and pre-registered for exactly
 *                     one sessionId (broker.registerLease). A mismatched
 *                     secret, an already-consumed secret, or a mismatched
 *                     sessionId closes the socket WITHOUT any response.
 *   permission_request { type, permissionRequestId?, toolName, input,
 *                      toolUseId? }
 *                     The broker assigns permissionRequestId when absent,
 *                     journals a `permission.requested` event, starts the
 *                     wait timer and replies request_registered.
 *   abort             { type, permissionRequestId }
 *                     The adapter is going away (MCP connection to Claude
 *                     closed); the request resolves as denied.
 *
 * Broker → Adapter
 *   request_registered { type, permissionRequestId }
 *   decision           { type, permissionRequestId, behavior: "allow",
 *                        updatedInput, toolUseId? }
 *                    | { type, permissionRequestId, behavior: "deny",
 *                        message, interrupt: false, toolUseId? }
 *                     Allow carries the ORIGINAL request input verbatim;
 *                     first version never carries updatedPermissions.
 *   error             { type, code, message, permissionRequestId? }
 *                     Malformed or semantically invalid frame; the
 *                     connection stays open. permissionRequestId is present
 *                     exactly when the offending frame identified a request:
 *                     invalid_request echoes the adapter-supplied id of the
 *                     rejected permission_request, unknown_permission_request
 *                     carries the abort's id. The adapter settles that
 *                     pending call as denied (fail closed); frames that
 *                     identify no request (invalid_frame, unknown_frame)
 *                     omit the id.
 */

/** Upper bound for a single frame payload (guards against runaway peers). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Thrown by the decoder on oversize or non-JSON payloads; callers destroy. */
export class FrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

export interface HelloFrame {
  readonly type: "hello";
  readonly leaseSecret: string;
  readonly sessionId: string;
}

export interface PermissionRequestFrame {
  readonly type: "permission_request";
  /** Assigned by the adapter (MCP request id) or by the broker when absent. */
  readonly permissionRequestId?: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolUseId?: string;
}

export interface AbortFrame {
  readonly type: "abort";
  readonly permissionRequestId: string;
}

export type AdapterFrame = HelloFrame | PermissionRequestFrame | AbortFrame;

export interface RequestRegisteredFrame {
  readonly type: "request_registered";
  readonly permissionRequestId: string;
}

export type DecisionFrame = {
  readonly type: "decision";
  readonly permissionRequestId: string;
  readonly behavior: "allow";
  readonly updatedInput: Readonly<Record<string, unknown>>;
  readonly toolUseId?: string;
} | {
  readonly type: "decision";
  readonly permissionRequestId: string;
  readonly behavior: "deny";
  readonly message: string;
  /** Always false: a denial never interrupts the whole session (spec §9). */
  readonly interrupt: false;
  readonly toolUseId?: string;
};

export interface ErrorFrame {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly permissionRequestId?: string;
}

export type BrokerFrame = RequestRegisteredFrame | DecisionFrame | ErrorFrame;

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Encode one frame: 4-byte big-endian length + UTF-8 JSON body. */
export function encodeFrame(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameProtocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame decoder. Feed arbitrary socket chunks; each push returns
 * the complete JSON values decoded in chunk order. Throws FrameProtocolError
 * on an oversize length or invalid JSON — the connection must be destroyed.
 */
export function createFrameDecoder(): { push(chunk: Buffer): unknown[] } {
  let buffer: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): unknown[] {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const values: unknown[] = [];
      for (;;) {
        if (buffer.length < 4) break;
        const length = buffer.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) {
          throw new FrameProtocolError(`declared frame length ${length} exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          values.push(JSON.parse(body.toString("utf8")));
        } catch (error) {
          throw new FrameProtocolError(`frame body is not valid JSON: ${(error as Error).message}`);
        }
      }
      return values;
    },
  };
}

/** True for plain objects (`{}`-literals / JSON objects), false for arrays/null/primitives. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

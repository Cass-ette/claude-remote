import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION, type EventPayload, type EventType } from "../protocol/v1/types.js";

/**
 * WebSocket boundary for the App<->Bridge protocol (spec §8.1).
 *
 * Subprotocol: the server must explicitly select `claude-remote.v1`.
 * A client offering only a different `claude-remote.vN` version is accepted
 * (so it receives a close frame, not just a failed Upgrade) and then closed
 * with 4426. A client offering no subprotocol header at all gets the Upgrade
 * rejected with HTTP 400.
 *
 * Auth and device pairing are stubs until Chunk 3: any `Bearer ...`
 * Authorization plus non-empty device-session header is accepted, and only
 * one device may be connected at a time.
 */

export const WS_PATH = "/api/v1/ws";

/** Application-level close codes from spec §8.1 (4xxx private-use range). */
export const CLOSE_CODE = {
  /** Access or device authentication invalid. */
  AUTH_INVALID: 4401,
  /** Device or project not authorized. */
  FORBIDDEN: 4403,
  /** Session write conflict. */
  SESSION_CONFLICT: 4409,
  /** Client state must resynchronize. */
  RESYNC_REQUIRED: 4410,
  /** Protocol version incompatible. */
  PROTOCOL_INCOMPATIBLE: 4426,
  /** Bridge internal error. */
  INTERNAL_ERROR: 4500,
} as const;

export type CloseCode = (typeof CLOSE_CODE)[keyof typeof CLOSE_CODE];

export const WS_CLOSE_CODES: ReadonlySet<CloseCode> = new Set(Object.values(CLOSE_CODE));

const DEVICE_SESSION_HEADER = "x-claude-remote-device-session";
const CLAUDE_REMOTE_PROTOCOL_RE = /^claude-remote\.v\d+$/;

/** Event shape accepted by SessionConnection.send(); serialized per §8.4. */
export interface OutboundEvent {
  readonly eventId: bigint;
  readonly sessionId: string;
  readonly eventType: EventType;
  readonly timestamp?: string;
  readonly payload: EventPayload;
}

/**
 * One accepted WebSocket: wraps the raw socket, tracks the device/session
 * association established during auth (stubbed in Chunk 2), and enforces
 * §8.1 close codes on close().
 */
export interface SessionConnection {
  readonly socket: WebSocket;
  /** Device-session token from auth; set to the header value until Chunk 3. */
  readonly deviceSession: string | null;
  /** Session bound after session.resume; null until Chunk 3 wiring. */
  sessionId: string | null;
  /** Serialize and flush a single §8.4 event with decimal-string eventId. */
  send(event: OutboundEvent): void;
  /** Close with one of the documented §8.1 application close codes. */
  close(code: CloseCode, reason: string): void;
}

export interface WebSocketServiceOptions {
  /** Called after headers/subprotocol checks pass and the registry accepts the device. */
  onConnect?: (connection: SessionConnection) => void;
  /** Called with each parsed JSON message from an authenticated connection. */
  onCommand?: (connection: SessionConnection, command: unknown) => void;
}

export interface WebSocketService {
  /** Currently connected device-session tokens (single-device stub registry). */
  readonly connectedDevices: ReadonlySet<string>;
  /** Close every active connection (server shutdown path). */
  closeAll(code: CloseCode, reason: string): void;
}

export function registerWebSocket(
  app: FastifyInstance,
  options: WebSocketServiceOptions = {},
): WebSocketService {
  const registry = new Map<string, SessionConnection>();

  // The route must be registered in a scope where the websocket plugin has
  // already resolved; otherwise fastify treats it as a plain HTTP route and
  // the handler receives (request, reply) instead of (socket, request).
  void app.register(async function websocketScope(scope) {
    await scope.register(websocketPlugin, {
      options: {
        handleProtocols(protocols: Set<string>): string | false {
          if (protocols.has(PROTOCOL_VERSION)) return PROTOCOL_VERSION;
          // Select the offered claude-remote.vN so the client gets a real
          // close frame (4426) instead of a bare Upgrade rejection; the
          // route handler then rejects the version.
          for (const offered of protocols) {
            if (CLAUDE_REMOTE_PROTOCOL_RE.test(offered)) return offered;
          }
          return false;
        },
      },
    });

    scope.get(
      WS_PATH,
      {
        websocket: true,
        // Missing subprotocol header: ws never invokes handleProtocols, so
        // the server would accept with no explicit selection — reject the
        // Upgrade outright with HTTP 400 instead (spec §8.1).
        preValidation: async (request, reply) => {
          if (request.headers["sec-websocket-protocol"] === undefined) {
            await reply.code(400).send({ error: "subprotocol_required", expected: PROTOCOL_VERSION });
          }
        },
      },
      (socket, request) => {
        const selected = socket.protocol;
        if (!selected) {
          socket.close(CLOSE_CODE.PROTOCOL_INCOMPATIBLE, "subprotocol claude-remote.v1 required");
          return;
        }
        if (selected !== PROTOCOL_VERSION) {
          socket.close(CLOSE_CODE.PROTOCOL_INCOMPATIBLE, `unsupported protocol version: ${selected}`);
          return;
        }

        // Stub auth (Chunk 3 replaces with Access assertion validation).
        const authorization = request.headers.authorization;
        if (
          typeof authorization !== "string" ||
          !authorization.startsWith("Bearer ") ||
          authorization.length <= "Bearer ".length
        ) {
          socket.close(CLOSE_CODE.AUTH_INVALID, "invalid or missing authorization");
          return;
        }
        const deviceSession = request.headers[DEVICE_SESSION_HEADER];
        if (typeof deviceSession !== "string" || deviceSession.length === 0) {
          socket.close(CLOSE_CODE.AUTH_INVALID, "missing device session");
          return;
        }

        // Single paired device stub: only one connected device at a time;
        // Chunk 3 replaces this with real device-session validation.
        if (registry.size > 0) {
          socket.close(CLOSE_CODE.FORBIDDEN, "another device is already connected");
          return;
        }

        const connection: SessionConnection = {
          socket,
          deviceSession,
          sessionId: null,
          send(event) {
            // §8.4: eventId is a decimal string in JSON to avoid JS/Kotlin
            // precision loss on uint64 values.
            const message = JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              eventId: event.eventId.toString(),
              sessionId: event.sessionId,
              eventType: event.eventType,
              timestamp: event.timestamp ?? new Date().toISOString(),
              payload: event.payload,
            });
            socket.send(message);
          },
          close(code, reason) {
            if (!WS_CLOSE_CODES.has(code)) {
              throw new Error(`undocumented close code: ${code}`);
            }
            socket.close(code, reason);
          },
        };

        registry.set(deviceSession, connection);
        const unregister = () => {
          if (registry.get(deviceSession) === connection) registry.delete(deviceSession);
        };
        socket.on("close", unregister);
        socket.on("error", unregister);

        socket.on("message", (raw) => {
          try {
            options.onCommand?.(connection, JSON.parse(String(raw)));
          } catch {
            socket.close(CLOSE_CODE.INTERNAL_ERROR, "malformed message");
          }
        });

        options.onConnect?.(connection);
      },
    );
  });

  return {
    get connectedDevices() {
      return new Set(registry.keys());
    },
    closeAll(code, reason) {
      for (const conn of registry.values()) {
        try {
          conn.close(code, reason);
        } catch {
          // already closing
        }
      }
      registry.clear();
    },
  };
}

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
 * Authentication has two modes:
 *  - WITHOUT `options.authenticate` (legacy stub, Chunk 2 tests): any
 *    `Bearer ...` Authorization plus a non-empty device-session header is
 *    accepted, and only one device may be connected at a time.
 *  - WITH `options.authenticate` (Task 24 runtime): the injected
 *    authenticator performs the real Access-assertion + device-session
 *    validation and returns the device identity plus a write deadline.
 *    The registry is keyed by deviceId, messages that arrive while
 *    authentication is in flight are buffered and replayed in order once it
 *    succeeds, and the socket is closed 4401 when the deadline (the earlier
 *    of the Access `exp` and the device-session expiry) is reached.
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
 * Result of the injected authenticator: either the accepted device identity
 * (with the connection's write deadline, epoch ms) or a documented close
 * code to reject the connection with.
 */
export type AuthenticationResult =
  | {
      readonly deviceId: string;
      readonly accessSubject: string;
      /** Epoch ms when this connection must be closed (4401). */
      readonly expiresAtMs: number;
    }
  | { readonly code: CloseCode; readonly reason: string };

export type Authenticator = (headers: Record<string, string | string[] | undefined>) => Promise<AuthenticationResult>;

/**
 * One accepted WebSocket: wraps the raw socket, tracks the device/session
 * association established during auth, and enforces §8.1 close codes on
 * close().
 */
export interface SessionConnection {
  readonly socket: WebSocket;
  /** Device-session token from auth; set to the header value in stub mode. */
  readonly deviceSession: string | null;
  /** Authenticated device identity (real auth mode only; null in stub mode). */
  readonly deviceId: string | null;
  /** Authenticated Access subject (real auth mode only; null in stub mode). */
  readonly accessSubject: string | null;
  /** Session bound after session.resume; null until wired by the runtime. */
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
  /**
   * Real authentication (Task 24). When present it replaces the Chunk 2 stub
   * entirely: the stub Bearer/device-session checks and the token-keyed
   * registry are bypassed and the registry is keyed by deviceId.
   */
  authenticate?: Authenticator;
}

export interface WebSocketService {
  /** Currently connected device keys (deviceId in real mode; device-session token in stub mode). */
  readonly connectedDevices: ReadonlySet<string>;
  /** Deliver one §8.4 event to every live connection of a device (real mode). */
  sendToDevice(deviceId: string, event: OutboundEvent): void;
  /** Close every live connection of a device with the given code (revocation). */
  closeDevice(deviceId: string, code: CloseCode, reason: string): void;
  /** All live connections. */
  connections(): readonly SessionConnection[];
  /** Close every active connection (server shutdown path). */
  closeAll(code: CloseCode, reason: string): void;
}

export function registerWebSocket(
  app: FastifyInstance,
  options: WebSocketServiceOptions = {},
): WebSocketService {
  const registry = new Map<string, SessionConnection>();
  const timers = new Map<string, NodeJS.Timeout>();

  function register(key: string, connection: SessionConnection): void {
    // A same-key reconnect supersedes the old socket (the old connection is
    // closed; the registry keeps exactly one entry per key).
    const old = registry.get(key);
    registry.set(key, connection);
    if (old !== undefined && old !== connection) {
      try {
        old.close(CLOSE_CODE.AUTH_INVALID, "superseded by a new connection");
      } catch {
        // already closing
      }
    }
  }

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

        if (options.authenticate === undefined) {
          acceptWithStubAuth(socket, request);
          return;
        }

        acceptWithRealAuth(socket, request, options.authenticate);
      },
    );

    function makeConnection(socket: WebSocket): SessionConnection {
      return {
        socket,
        deviceSession: null,
        deviceId: null,
        accessSubject: null,
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
    }

    function attachMessageHandling(
      socket: WebSocket,
      connection: SessionConnection,
      key: string,
      request: import("fastify").FastifyRequest,
    ): void {
      const unregister = () => {
        if (registry.get(key) === connection) registry.delete(key);
        const timer = timers.get(key);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(key);
        }
      };
      socket.on("close", unregister);
      socket.on("error", unregister);

      socket.on("message", (raw: unknown) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          socket.close(CLOSE_CODE.INTERNAL_ERROR, "malformed message");
          return;
        }
        try {
          options.onCommand?.(connection, parsed);
        } catch (error) {
          request.log.warn(
            { err: error },
            "onCommand handler threw; message was valid JSON",
          );
        }
      });
    }

    function acceptWithStubAuth(
      socket: WebSocket,
      request: import("fastify").FastifyRequest,
    ): void {
      // Stub auth (legacy Chunk 2 behavior; real deployments inject
      // `authenticate` and never reach this path).
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

      // Single paired device stub: only one connected device at a time.
      if (registry.size > 0) {
        socket.close(CLOSE_CODE.FORBIDDEN, "another device is already connected");
        return;
      }

      const connection: SessionConnection = {
        ...makeConnection(socket),
        deviceSession,
      };

      register(deviceSession, connection);
      attachMessageHandling(socket, connection, deviceSession, request);
      options.onConnect?.(connection);
    }

    function acceptWithRealAuth(
      socket: WebSocket,
      request: import("fastify").FastifyRequest,
      authenticate: Authenticator,
    ): void {
      let settled = false;
      // Messages that arrive while authentication is in flight are buffered
      // and replayed in order once it succeeds (never dropped).
      const preAuth: Buffer[] = [];
      const bufferPreAuth = (raw: unknown): void => {
        if (!settled) preAuth.push(Buffer.from(String(raw)));
      };
      socket.on("message", bufferPreAuth);

      authenticate(request.headers).then(
        (result) => {
          if (settled) return;
          settled = true;
          socket.off("message", bufferPreAuth);
          if ("code" in result) {
            socket.close(result.code, result.reason);
            return;
          }
          const { deviceId, accessSubject, expiresAtMs } = result;

          const connection: SessionConnection = {
            ...makeConnection(socket),
            deviceId,
            accessSubject,
          };

          register(deviceId, connection);
          attachMessageHandling(socket, connection, deviceId, request);

          // Write deadline: the earlier of the Access `exp` and the device
          // session expiry. Once passed the socket is closed 4401 and the
          // client must re-authenticate.
          const remaining = expiresAtMs - Date.now();
          if (remaining > 0) {
            timers.set(
              deviceId,
              setTimeout(() => {
                timers.delete(deviceId);
                if (registry.get(deviceId) === connection) {
                  registry.delete(deviceId);
                  connection.close(CLOSE_CODE.AUTH_INVALID, "device session expired");
                }
              }, remaining),
            );
          }

          options.onConnect?.(connection);

          for (const buffered of preAuth) {
            const raw = buffered.toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              socket.close(CLOSE_CODE.INTERNAL_ERROR, "malformed message");
              return;
            }
            try {
              options.onCommand?.(connection, parsed);
            } catch (error) {
              request.log.warn({ err: error }, "onCommand handler threw; message was valid JSON");
            }
          }
        },
        (error) => {
          if (settled) return;
          settled = true;
          socket.off("message", bufferPreAuth);
          request.log.warn({ err: error }, "websocket authentication failed");
          socket.close(CLOSE_CODE.AUTH_INVALID, "authentication failed");
        },
      );
    }
  });

  return {
    get connectedDevices() {
      return new Set(registry.keys());
    },
    sendToDevice(deviceId, event) {
      const conn = registry.get(deviceId);
      if (conn === undefined) return;
      try {
        conn.send(event);
      } catch {
        // socket already closing; unregister will follow via the close event
      }
    },
    closeDevice(deviceId, code, reason) {
      const conn = registry.get(deviceId);
      if (conn === undefined) return;
      registry.delete(deviceId);
      const timer = timers.get(deviceId);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(deviceId);
      }
      try {
        conn.close(code, reason);
      } catch {
        // already closing
      }
    },
    connections() {
      return [...registry.values()];
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
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

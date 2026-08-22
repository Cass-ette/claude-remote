import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  registerWebSocket,
  type SessionConnection,
  WS_CLOSE_CODES,
  WS_PATH,
} from "../../src/server/websocket-server.js";

const AUTH_HEADERS = {
  authorization: "Bearer test-token",
  "x-claude-remote-device-session": "device-session-1",
} as const;

const V1 = "claude-remote.v1";

let app: FastifyInstance | undefined;
let connections: SessionConnection[];
let onConnect: (conn: SessionConnection) => void;
let onCommand: (conn: SessionConnection, command: unknown) => void;

async function startServer(): Promise<string> {
  connections = [];
  onConnect = () => {};
  onCommand = () => {};
  app = Fastify({ logger: false });
  registerWebSocket(app, {
    onConnect: (conn) => {
      connections.push(conn);
      onConnect(conn);
    },
    onCommand: (conn, command) => onCommand(conn, command),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { address, port } = app.server.address() as { address: string; port: number };
  return `ws://${address}:${port}${WS_PATH}`;
}

afterEach(async () => {
  for (const conn of connections) {
    try {
      conn.close(4500, "test teardown");
    } catch {
      // already closed
    }
  }
  await app?.close();
  app = undefined;
});

function open(url: string, headers: Record<string, string>, protocols?: string) {
  const protocolList = protocols?.split(",").map((p) => p.trim());
  const ws =
    protocols === undefined
      ? new WebSocket(url, headers)
      : new WebSocket(url, protocolList, { headers });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  return { ws, opened, closed };
}

describe("websocket subprotocol negotiation (spec 8.1)", () => {
  it("rejects the Upgrade when Sec-WebSocket-Protocol is missing", async () => {
    const url = await startServer();
    const { opened } = open(url, AUTH_HEADERS);
    await expect(opened).rejects.toThrow(/400|Unexpected server response|subprotocol/);
  });

  it("rejects an unrecognized subprotocol with a failed Upgrade", async () => {
    const url = await startServer();
    const { opened } = open(url, AUTH_HEADERS, "some.other.protocol");
    await expect(opened).rejects.toThrow(/400|Unexpected server response|subprotocol/);
  });

  it("closes with 4426 when the client only offers an incompatible claude-remote version", async () => {
    const url = await startServer();
    const { ws, opened, closed } = open(url, AUTH_HEADERS, "claude-remote.v2");
    await opened;
    const { code, reason } = await closed;
    expect(code).toBe(4426);
    expect(reason).toContain("protocol");
    ws.terminate();
  });

  it("selects claude-remote.v1 when the client offers both v1 and v2", async () => {
    const url = await startServer();
    const { ws, opened } = open(url, AUTH_HEADERS, "claude-remote.v2, claude-remote.v1");
    await opened;
    expect(ws.protocol).toBe(V1);
    ws.close();
  });
});

describe("websocket required headers (spec 8.1)", () => {
  it("closes with 4401 when Authorization is missing", async () => {
    const url = await startServer();
    const { ws, opened, closed } = open(url, { "x-claude-remote-device-session": "ds-1" }, V1);
    await opened;
    const { code } = await closed;
    expect(code).toBe(4401);
    ws.terminate();
  });

  it("closes with 4401 when Authorization is not a Bearer token", async () => {
    const url = await startServer();
    const { ws, opened, closed } = open(url, { authorization: "Basic abc", "x-claude-remote-device-session": "ds-1" }, V1);
    await opened;
    expect((await closed).code).toBe(4401);
    ws.terminate();
  });

  it("closes with 4401 when X-Claude-Remote-Device-Session is missing", async () => {
    const url = await startServer();
    const { ws, opened, closed } = open(url, { authorization: "Bearer t" }, V1);
    await opened;
    expect((await closed).code).toBe(4401);
    ws.terminate();
  });
});

describe("SessionConnection event delivery (spec 8.4)", () => {
  it("delivers events with decimal-string eventIds", async () => {
    const url = await startServer();
    const { ws, opened } = open(url, AUTH_HEADERS, V1);
    const received = new Promise<Record<string, unknown>[]>((resolve) => {
      const msgs: Record<string, unknown>[] = [];
      ws.on("message", (raw) => {
        msgs.push(JSON.parse(raw.toString()));
        if (msgs.length === 2) resolve(msgs);
      });
    });
    await opened;
    const conn = await waitForConnection();
    conn.send({
      eventId: 1n,
      sessionId: "s1",
      eventType: "session.state.changed",
      payload: { state: "running" },
    });
    conn.send({
      eventId: 9007199254740993n,
      sessionId: "s1",
      eventType: "session.state.changed",
      payload: { state: "stopped" },
    });
    const msgs = await received;
    expect(msgs[0]!.eventId).toBe("1");
    expect(msgs[1]!.eventId).toBe("9007199254740993");
    expect(msgs[0]!.protocolVersion).toBe(V1);
    expect(msgs[0]!.eventType).toBe("session.state.changed");
    ws.close();
  });

  it("closes with the requested documented close code", async () => {
    const url = await startServer();
    const { ws, opened, closed } = open(url, AUTH_HEADERS, V1);
    await opened;
    const conn = await waitForConnection();
    conn.close(4410, "resync required");
    const { code, reason } = await closed;
    expect(code).toBe(4410);
    expect(reason).toBe("resync required");
    ws.terminate();
  });

  it("rejects undocumented close codes", async () => {
    const url = await startServer();
    const { ws, opened } = open(url, AUTH_HEADERS, V1);
    await opened;
    const conn = await waitForConnection();
    expect(() => conn.close(1000 as never, "nope")).toThrow();
    ws.close();
  });
});

describe("single paired device enforcement (stub)", () => {
  it("closes a concurrent second device with 4403", async () => {
    const url = await startServer();
    const first = open(url, AUTH_HEADERS, V1);
    await first.opened;
    const second = open(url, { ...AUTH_HEADERS, "x-claude-remote-device-session": "device-session-2" }, V1);
    await second.opened;
    const { code } = await second.closed;
    expect(code).toBe(4403);
    first.ws.close();
    second.ws.terminate();
  });

  it("allows the same device-session to reconnect after the old socket closed", async () => {
    const url = await startServer();
    const first = open(url, AUTH_HEADERS, V1);
    await first.opened;
    await waitForConnection();
    first.ws.close(1000);
    await first.closed;
    const second = open(url, AUTH_HEADERS, V1);
    await second.opened;
    await waitForConnection(2);
    second.ws.close();
  });
});

describe("inbound commands", () => {
  it("passes parsed JSON messages to onCommand", async () => {
    const url = await startServer();
    const { ws, opened } = open(url, AUTH_HEADERS, V1);
    const command = new Promise<unknown>((resolve) => {
      onCommand = (_conn, cmd) => resolve(cmd);
    });
    await opened;
    await waitForConnection();
    ws.send(JSON.stringify({ protocolVersion: V1, requestId: "r1", commandType: "session.list" }));
    await expect(command).resolves.toMatchObject({ requestId: "r1", commandType: "session.list" });
    ws.close();
  });
});

describe("WS_CLOSE_CODES", () => {
  it("documents exactly the spec 8.1 application close codes", () => {
    expect([...WS_CLOSE_CODES].sort()).toEqual([4401, 4403, 4409, 4410, 4426, 4500]);
  });
});

function waitForConnection(count = 1): Promise<SessionConnection> {
  return new Promise((resolve) => {
    const check = () => {
      if (connections.length >= count) resolve(connections[connections.length - 1]!);
      else setTimeout(check, 10);
    };
    check();
  });
}

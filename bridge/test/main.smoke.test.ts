import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import WebSocket from "ws";
import { startBridge, type BridgeHandle } from "../src/main.js";

const V1 = "claude-remote.v1";

const AUTH_HEADERS = {
  authorization: "Bearer stub",
  "x-claude-remote-device-session": "stub",
} as const;

let bridge: BridgeHandle | undefined;
let dataDir: string | undefined;

/** Reserve a free port by binding to 0 and releasing it (config rejects port 0). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

async function boot(): Promise<{ bridge: BridgeHandle; baseUrl: string; wsUrl: string }> {
  dataDir = mkdtempSync(join(tmpdir(), "bridge-smoke-"));
  const port = await freePort();
  const env = {
    BRIDGE_DATA_DIR: dataDir,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(port),
  };
  const handle = await startBridge(env);
  bridge = handle;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { bridge: handle, baseUrl, wsUrl: `${baseUrl.replace("http", "ws")}/api/v1/ws` };
}

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

describe("main smoke (Task 12)", () => {
  it("boots with config -> db -> journal -> ledger -> http -> ws", async () => {
    const { bridge: b, baseUrl } = await boot();

    // Database file created owner-only at config.databasePath.
    const st = statSync(b.config.databasePath);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);

    // Schema migrated.
    const applied = b.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    expect(applied.map((r) => r.version)).toEqual([1]);

    // Journal/ledger constructible; nothing pending after boot.
    expect(b.journal.pendingBytes()).toBe(0);
  });

  it("GET /api/v1/health returns ok", async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/v1/capabilities advertises claude-remote.v1", async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.protocolVersion).toBe(V1);
    // Null placeholder is acceptable until Chunk 3 wires the version probe.
    expect(body.claudeCodeVersion === null || typeof body.claudeCodeVersion === "string").toBe(true);
    expect(typeof body.bridgeVersion).toBe("string");
  });

  it("accepts a WebSocket with stub auth and correct headers", async () => {
    const { wsUrl } = await boot();
    const ws = new WebSocket(wsUrl, [V1], { headers: AUTH_HEADERS });
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await opened;
    expect(ws.protocol).toBe(V1);
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });

  it("closes with 4401 when the device-session header is missing", async () => {
    const { wsUrl } = await boot();
    const ws = new WebSocket(wsUrl, [V1], {
      headers: { authorization: "Bearer stub" },
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await closed.then((code) => {
      expect(code).toBe(4401);
    });
  });

  it("closes with 4401 when Authorization is missing", async () => {
    const { wsUrl } = await boot();
    const ws = new WebSocket(wsUrl, [V1], {
      headers: { "x-claude-remote-device-session": "stub" },
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    expect(await closed).toBe(4401);
  });

  it("client closing its socket does not crash the server", async () => {
    const { baseUrl, wsUrl, bridge: b } = await boot();
    const ws = new WebSocket(wsUrl, [V1], { headers: AUTH_HEADERS });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.terminate();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    // Server stays healthy.
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(b.wsService.connectedDevices.size).toBe(0);
  });

  it("close() shuts down everything within 2 seconds", async () => {
    const { wsUrl } = await boot();
    const ws = new WebSocket(wsUrl, [V1], { headers: AUTH_HEADERS });
    await new Promise<void>((resolve) => ws.once("open", resolve));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    const handle = bridge!;
    bridge = undefined; // afterEach must not double-close
    const start = Date.now();
    await handle.close();
    const { code, reason } = await closed;
    expect(Date.now() - start).toBeLessThan(2000);
    expect(code).toBe(4500);
    expect(reason).toContain("shutdown");
    // Subsequent requests fail: server is closed.
    await expect(fetch(`http://127.0.0.1:${handle.config.port}/api/v1/health`)).rejects.toThrow();
    dataDir = handle.config.dataDir; // keep afterEach cleanup
  });
});

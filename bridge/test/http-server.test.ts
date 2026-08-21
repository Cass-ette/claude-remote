import { createConnection, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/server/http-server.js";

const dataDirs: string[] = [];
let app: ReturnType<typeof Fastify> | undefined;
let config: BridgeConfig;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-http-test-"));
  dataDirs.push(dir);
  config = loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43190", BRIDGE_DATA_DIR: dir });
  app = startHttpServer(config, {});
});

afterAll(async () => {
  await app?.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/v1/health", () => {
  it("returns { status: 'ok' }", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/v1/capabilities", () => {
  it("returns the full capability contract from spec 8.1", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocolVersion).toBe("claude-remote.v1");
    expect(typeof body.bridgeVersion).toBe("string");
    expect(body.bridgeVersion.length).toBeGreaterThan(0);
    expect(body.minimumAndroidVersion).toBe(28);
    // null until Chunk 3 wires the real Claude Code version probe.
    expect(body.claudeCodeVersion).toBeNull();
    expect(Array.isArray(body.features)).toBe(true);
    expect(body.features).toEqual([]);
    expect(typeof body.serverTime).toBe("string");
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });
});

describe("paths outside /api/v1/", () => {
  it("returns 404", async () => {
    for (const url of ["/", "/health", "/api/v2/health", "/api/v1/nope", "/admin"]) {
      const res = await app!.inject({ method: "GET", url });
      expect(res.statusCode, `GET ${url}`).toBe(404);
    }
  });
});

describe("loopback binding", () => {
  it("listens on 127.0.0.1 only and refuses non-loopback interfaces", async () => {
    await app!.listen({ port: 0, host: "127.0.0.1" });
    const tcp = app!.addresses().find(
      (a: AddressInfo): a is AddressInfo => a.family === "IPv4",
    );
    expect(tcp).toBeDefined();
    expect(tcp!.address).toBe("127.0.0.1");

    const lanIps = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i !== undefined && !i.internal && i.family === "IPv4")
      .map((i) => (i as { address: string }).address);

    if (lanIps.length === 0) {
      // No LAN interface on this host; the config-level loopback check
      // plus the bound-address assertion above still prove the invariant.
      return;
    }

    const attempts = await Promise.all(
      lanIps.map(
        (ip) =>
          new Promise<boolean>((resolve) => {
            const socket = createConnection({ host: ip, port: tcp!.port });
            const finish = (refused: boolean) => {
              socket.destroy();
              resolve(refused);
            };
            socket.setTimeout(1000, () => finish(true));
            socket.on("error", () => finish(true));
            socket.on("connect", () => finish(false));
          }),
      ),
    );
    // Connecting to the LAN IP must fail on every non-loopback interface.
    expect(attempts.every((refused) => refused)).toBe(true);

    await app!.close();
  });
});

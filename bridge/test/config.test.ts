import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const createdDirs: string[] = [];
afterAll(() => {
  // Best-effort cleanup; tmp dirs are fine to leave behind on macOS.
  for (const dir of createdDirs) {
    import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }));
  }
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-test-"));
  createdDirs.push(dir);
  return dir;
}

describe("loadConfig", () => {
  it("requires loopback bind and rejects other interfaces", () => {
    const dir = dataDir();
    const cfg = loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dir });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(43111);
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.databasePath).toBe(join(dir, "bridge.db"));
    expect(cfg.auditLogPath).toBe(join(dir, "audit.jsonl"));
    // dataDir is created with owner-only permissions (0o700), subject to umask.
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("accepts IPv6 loopback ::1", () => {
    const cfg = loadConfig({ BRIDGE_HOST: "::1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() });
    expect(cfg.host).toBe("::1");
  });

  it("rejects non-loopback hosts", () => {
    expect(() => loadConfig({ BRIDGE_HOST: "0.0.0.0", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() }))
      .toThrow(/loopback/);
    expect(() => loadConfig({ BRIDGE_HOST: "192.168.1.5", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() }))
      .toThrow(/loopback/);
    expect(() => loadConfig({ BRIDGE_HOST: "localhost", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() }))
      .toThrow(/loopback/);
  });

  it("rejects privileged, zero, and out-of-range ports", () => {
    for (const port of ["0", "1023", "65536", "-1", "not-a-port"]) {
      expect(() => loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: port, BRIDGE_DATA_DIR: dataDir() }))
        .toThrow(/port/i);
    }
  });

  it("rejects relative or missing data dirs", () => {
    expect(() => loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: "relative/path" }))
      .toThrow(/absolute/i);
    expect(() => loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111" })).toThrow(/BRIDGE_DATA_DIR/);
  });

  it("exposes pending-events byte budget with a 64 MiB default", async () => {
    const { PENDING_EVENTS_BYTE_BUDGET_DEFAULT } = await import("../src/config.js");
    const cfg = loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() });
    expect(cfg.pendingEventsByteBudget).toBe(PENDING_EVENTS_BYTE_BUDGET_DEFAULT);
    expect(PENDING_EVENTS_BYTE_BUDGET_DEFAULT).toBe(64 * 1024 * 1024);

    const custom = loadConfig({
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: "43111",
      BRIDGE_DATA_DIR: dataDir(),
      BRIDGE_PENDING_EVENTS_BYTE_BUDGET: "1024",
    });
    expect(custom.pendingEventsByteBudget).toBe(1024);
  });

  it("exposes the permission timeout with a 300 s default (spec §6.4)", () => {
    const cfg = loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir() });
    expect(cfg.permissionTimeoutSeconds).toBe(300);

    const custom = loadConfig({
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: "43111",
      BRIDGE_DATA_DIR: dataDir(),
      BRIDGE_PERMISSION_TIMEOUT_SECONDS: "30",
    });
    expect(custom.permissionTimeoutSeconds).toBe(30);

    for (const bad of ["0", "-5", "1.5", "soon"]) {
      expect(() =>
        loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: dataDir(), BRIDGE_PERMISSION_TIMEOUT_SECONDS: bad }),
      ).toThrow(/PERMISSION_TIMEOUT/);
    }
  });
});

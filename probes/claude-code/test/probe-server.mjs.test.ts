// Guard for the plain-ESM probe server port.
//
// Claude Code 2.1.133 spawns stdio MCP servers via a shell with a restricted
// PATH where `npx`/`tsx` do not resolve. The compatibility gate therefore
// spawns the probe server as `<absolute node> <permission-probe-server.mjs>`.
// This test proves the server works under such a restricted environment by
// performing an MCP initialize + tools/list handshake over stdio with a
// minimal PATH.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const probeModule = fileURLToPath(new URL("../src/permission-probe-server.mjs", import.meta.url));

interface JsonRpcMsg {
  id?: number;
  result?: { tools?: Array<{ name: string }> };
  error?: { message: string };
}

function send(proc: import("node:child_process").ChildProcess, msg: unknown): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

async function readMsg(rl: import("node:readline").Interface): Promise<JsonRpcMsg> {
  const line = await new Promise<string>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for probe server response")), 10_000);
    rl.once("line", (l) => {
      clearTimeout(timer);
      resolveLine(l as string);
    });
  });
  return JSON.parse(line) as JsonRpcMsg;
}

describe("permission-probe-server.mjs under restricted PATH", () => {
  it("completes initialize + tools/list and lists the target tool", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "probe-server-"));
    try {
      const proc = spawn(
        process.execPath,
        [
          probeModule,
          "--role",
          "target",
          "--tool-name",
          "echo_probe_deadbeef",
          "--nonce",
          "n1",
          "--event-log",
          join(workdir, "events.log"),
          "--server-name",
          "claude_remote_probe"
        ],
        {
          // Simulate Claude Code's restricted spawn environment: npx/tsx are
          // not resolvable here. The server must still work because it is
          // spawned as plain node with absolute paths.
          env: { ...process.env, PATH: "/usr/bin:/bin" }
        }
      );
      const rl = createInterface({ input: proc.stdout! });
      let stderr = "";
      proc.stderr!.on("data", (d) => {
        stderr += d.toString();
      });

      try {
        send(proc, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "guard-test", version: "0.0.0" }
          }
        });
        const init = await readMsg(rl);
        expect(init.error).toBeUndefined();
        expect(init.result).toBeDefined();

        send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
        send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        const tools = await readMsg(rl);
        expect(tools.error).toBeUndefined();
        const names = tools.result?.tools?.map((t) => t.name) ?? [];
        expect(names).toContain("echo_probe_deadbeef");
      } finally {
        rl.close();
        proc.kill();
        if (stderr.trim()) {
          // Surface for debugging but do not fail on benign SDK warnings.
          // eslint-disable-next-line no-console
          console.error("probe-server stderr:", stderr);
        }
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});

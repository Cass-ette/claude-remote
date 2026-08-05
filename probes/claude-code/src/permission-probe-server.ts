// Two-role MCP server for the Claude Code permission gate.
//
// The compatibility gate spawns TWO independent stdio MCP processes from
// this module, configured in the same `--mcp-config` JSON:
//
//   1. **target server** — exposes a single side-effect-free tool whose name
//      is randomized per run (`echo_probe_<128-bit-hex>`). Claude is asked to
//      call this exact tool with a nonce. The tool itself just echoes the
//      nonce; the gate never trusts its return value, it trusts the FACT that
//      the tool was invoked (recorded via the shared event log).
//
//   2. **permission server** — exposes only the permission-prompt tool that
//      `--permission-prompt-tool` points at. Its behavior is configurable:
//      allow, deny, or simulate a permission timeout (never respond).
//
// Keeping these as two separate processes is critical: killing the permission
// server (Step 5 fail-closed) must NOT also kill the target server, otherwise
// "zero target executions" would be trivially true.
//
// The two processes communicate through a shared JSON-lines event log file
// (passed via `--event-log <path>`), not via the MCP transport. This keeps
// the MCP contract clean and lets the gate assert ordered, observed events.

import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface ProbeOptions {
  role: "target" | "permission";
  /** Target role only: randomized tool name (`echo_probe_<hex>`). */
  toolName?: string | undefined;
  /** Target role only: nonce the gate expects to see echoed back. */
  nonce?: string | undefined;
  /** Permission role only: decision to return. */
  decision?: "allow" | "deny" | undefined;
  /** Permission role only: when set, never respond (simulate a hung broker). */
  hangMs?: number | undefined;
  /** Shared event log path. */
  eventLog: string;
  /** Server name as it appears in mcp-config (e.g. `claude_remote_probe`). */
  serverName: string;
}

interface ParsedArgs {
  role: "target" | "permission";
  toolName?: string | undefined;
  nonce?: string | undefined;
  decision?: "allow" | "deny" | undefined;
  hangMs?: number | undefined;
  eventLog: string;
  serverName: string;
}

export function parseProbeArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { role: "permission", eventLog: "", serverName: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--role") {
      if (next !== "target" && next !== "permission") {
        throw new Error(`--role must be target|permission, got ${next ?? "(none)"}`);
      }
      out.role = next;
      i++;
    } else if (a === "--tool-name") {
      if (!next) throw new Error("--tool-name requires a value");
      out.toolName = next;
      i++;
    } else if (a === "--nonce") {
      if (!next) throw new Error("--nonce requires a value");
      out.nonce = next;
      i++;
    } else if (a === "--decision") {
      if (next !== "allow" && next !== "deny") {
        throw new Error(`--decision must be allow|deny, got ${next ?? "(none)"}`);
      }
      out.decision = next;
      i++;
    } else if (a === "--hang-ms") {
      if (!next) throw new Error("--hang-ms requires a value");
      out.hangMs = Number(next);
      i++;
    } else if (a === "--event-log") {
      if (!next) throw new Error("--event-log requires a value");
      out.eventLog = next;
      i++;
    } else if (a === "--server-name") {
      if (!next) throw new Error("--server-name requires a value");
      out.serverName = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: --role target|permission [--tool-name N] [--nonce V] " +
          "[--decision allow|deny] [--hang-ms N] --event-log PATH --server-name N\n"
      );
      process.exit(0);
    } else {
      throw new Error(`unknown probe-server argument: ${a}`);
    }
  }
  if (!out.eventLog) throw new Error("--event-log is required");
  if (!out.serverName) throw new Error("--server-name is required");
  return out;
}

async function appendEvent(path: string, event: Record<string, unknown>): Promise<void> {
  // O_APPEND is atomic for individual write() calls on most platforms for
  // small payloads; use a file handle and an explicit line to keep records
  // separable.
  const fh = await open(path, "a");
  try {
    await fh.writeFile(JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  } finally {
    await fh.close();
  }
}

const PermissionInput = z.object({
  tool_name: z.string(),
  input: z.unknown().optional()
});

async function runTarget(opts: Required<Omit<ProbeOptions, "decision" | "hangMs">>): Promise<void> {
  const server = new Server(
    { name: opts.serverName, version: "0.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: opts.toolName,
        description: "Side-effect-free echo probe. Returns the nonce it was given.",
        inputSchema: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === opts.toolName) {
      // Record OBSERVED execution BEFORE computing the result. The gate
      // trusts this log entry, not the tool return value.
      await appendEvent(opts.eventLog, {
        kind: "target_invocation",
        server: opts.serverName,
        tool: opts.toolName,
        nonce: opts.nonce
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, nonce: opts.nonce }) }]
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${req.params.name}` }]
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Append a started marker so the gate can verify the target server actually
  // came up (and stayed up across the permission-server kill test).
  await appendEvent(opts.eventLog, {
    kind: "target_started",
    server: opts.serverName,
    tool: opts.toolName
  });
}

async function runPermission(
  opts: {
    eventLog: string;
    serverName: string;
    decision?: "allow" | "deny" | undefined;
    hangMs?: number | undefined;
  }
): Promise<void> {
  const server = new Server(
    { name: opts.serverName, version: "0.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "decide",
        description:
          "Permission broker. Returns behavior===allow to approve a tool call.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: {}
          },
          required: ["tool_name"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "decide") {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }]
      };
    }
    // Parse strictly so a malformed input is observable.
    const parsed = PermissionInput.safeParse(req.params.arguments ?? {});
    const toolName = parsed.success ? parsed.data.tool_name : "(unparseable)";

    await appendEvent(opts.eventLog, {
      kind: "permission_prompted",
      server: opts.serverName,
      tool: toolName
    });

    if (opts.hangMs !== undefined && opts.hangMs > 0) {
      // Simulate a hung permission broker: never respond. The compatibility
      // gate's five-second timeout will fire and assert fail-closed.
      await new Promise<void>(() => {
        // intentionally never resolves
      });
    }

    const behavior = opts.decision === "deny" ? "deny" : "allow";
    const modifiedInput = parsed.success ? parsed.data.input : undefined;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            behavior,
          })
        }
      ]
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await appendEvent(opts.eventLog, {
    kind: "permission_started",
    server: opts.serverName,
    decision: opts.decision ?? "(unset)",
    hangMs: opts.hangMs ?? 0
  });
}

export async function runProbeServer(opts: ProbeOptions): Promise<void> {
  if (opts.role === "target") {
    if (!opts.toolName) throw new Error("target role requires --tool-name");
    if (!opts.nonce) throw new Error("target role requires --nonce");
    await runTarget({
      role: "target",
      toolName: opts.toolName,
      nonce: opts.nonce,
      eventLog: opts.eventLog,
      serverName: opts.serverName
    });
  } else {
    await runPermission({
      eventLog: opts.eventLog,
      serverName: opts.serverName,
      decision: opts.decision,
      hangMs: opts.hangMs
    });
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const parsed = parseProbeArgs(process.argv.slice(2));
  runProbeServer(parsed).catch((err) => {
    process.stderr.write(`probe-server: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}

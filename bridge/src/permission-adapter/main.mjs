// Standalone permission MCP adapter (spec §6.4, Task 18).
//
// Claude Code spawns this file as the per-session permission MCP server:
//
//     <absolute node> <absolute main.mjs>
//
// with BRIDGE_PERMISSION_SOCKET, BRIDGE_LEASE_SECRET and BRIDGE_SESSION_ID
// in the child environment (written by the process factory's
// `--strict-mcp-config` JSON). Claude Code launches stdio MCP servers with a
// restricted PATH where npx/tsx do not resolve, so this file is plain ESM
// JavaScript with no TypeScript build step and no runner — the same
// constraint the Phase 0 probe proved
// (probes/claude-code/src/permission-probe-server.mjs).
//
// Per `decide` call:
//   * validate the §6.4 input {tool_name, input, tool_use_id?} locally —
//     malformed input is denied without ever contacting the broker;
//   * lazily connect ONCE to the Bridge permission broker's 0600 Unix
//     socket (Task 17), prove the single-use lease secret with a hello
//     frame and forward the request (the lease is single-use, so a lost
//     connection is never re-established);
//   * answer with ONE MCP text content block whose text is the decision
//     JSON: {"behavior":"allow","updatedInput":<original input>} or
//     {"behavior":"deny","message":...,"interrupt":false} — `toolUseID` is
//     included only when the original request carried `tool_use_id`;
//   * fail closed everywhere: an unreachable broker socket and an
//     adapter-side hard timeout answer deny "bridge_unavailable" and exit
//     nonzero; a broker that closes the socket while a call is pending
//     (e.g. rejected lease) closes stdio WITHOUT any MCP result so Claude
//     Code fails the tool call — the path the Phase 0 gate verified.
//
// stdout belongs to the MCP protocol and secrets must never be logged, so
// the only stderr output is env-independent fatal diagnostics.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration (env only; values are never logged)
// ---------------------------------------------------------------------------

const SERVER_NAME = "claude_remote_permission";
const TOOL_NAME = "decide";

/**
 * Adapter-side hard timeout: the BROKER owns the real 5-minute wait (§6.4)
 * and denies on its own timer; this guard only fires when the broker goes
 * silent without closing the socket. Default: 300 s + 30 s grace.
 * Overridable via BRIDGE_PERMISSION_ADAPTER_TIMEOUT_MS (tests / diagnostics).
 */
const DEFAULT_HARD_TIMEOUT_MS = 330_000;

const socketPath = process.env.BRIDGE_PERMISSION_SOCKET ?? "";
const leaseSecret = process.env.BRIDGE_LEASE_SECRET ?? "";
const sessionId = process.env.BRIDGE_SESSION_ID ?? "";

if (socketPath === "" || leaseSecret === "" || sessionId === "") {
  const missing = [
    ["BRIDGE_PERMISSION_SOCKET", socketPath],
    ["BRIDGE_LEASE_SECRET", leaseSecret],
    ["BRIDGE_SESSION_ID", sessionId],
  ]
    .filter(([, value]) => value === "")
    .map(([key]) => key)
    .join(", ");
  process.stderr.write(`permission-adapter: required environment variables missing: ${missing}\n`);
  process.exit(1);
}

const hardTimeoutRaw = Number(process.env.BRIDGE_PERMISSION_ADAPTER_TIMEOUT_MS);
const hardTimeoutMs =
  Number.isInteger(hardTimeoutRaw) && hardTimeoutRaw > 0 ? hardTimeoutRaw : DEFAULT_HARD_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Frame codec — identical to bridge/src/permissions/socket-protocol.ts.
// Duplicated rather than imported because this file must run untransformed
// from both src/ and dist/ with only the Node runtime present.
// ---------------------------------------------------------------------------

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const values = [];
      for (;;) {
        if (buffer.length < 4) break;
        const length = buffer.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) {
          throw new Error(`declared frame length ${length} exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        values.push(JSON.parse(body.toString("utf8")));
      }
      return values;
    },
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Broker connection (single-use lease: exactly one connection, ever)
// ---------------------------------------------------------------------------

/** permissionRequestId → { resolve(outcome), timer } while a decision is awaited. */
const pendingDecisions = new Map();

let brokerSocket = undefined;
/**
 * Memoized connectBroker() promise. The MCP SDK dispatches tools/call
 * handlers CONCURRENTLY, so the lazy connect must be serialized: two pipelined
 * decide calls both seeing `brokerSocket === undefined` would both connect,
 * and two hello frames carry the same SINGLE-USE lease — the broker consumes
 * it on the first connection and destroys the second, killing a healthy
 * in-flight call. The memo is kept for the whole process lifetime (rejection
 * included): the lease makes any reconnect impossible, so a failed connect
 * must stay failed instead of retrying into a reconnect storm.
 */
let brokerConnectPromise = undefined;
/** True once the connection is gone for good — the consumed lease makes any
 * reconnection impossible, so every later call fails closed. */
let brokerDead = false;

let fatalExitScheduled = false;
/**
 * Bring the process down with a nonzero status after a fatal condition.
 * Delayed slightly so the SDK can flush a final JSON-RPC response (the
 * unreachable-broker path answers deny before exiting); in the no-response
 * paths the delay only makes the pipe close marginally later.
 */
function scheduleFatalExit() {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  setTimeout(() => {
    if (brokerSocket !== undefined) brokerSocket.destroy();
    process.exit(1);
  }, 250);
}

function settlePending(permissionRequestId, outcome) {
  const entry = pendingDecisions.get(permissionRequestId);
  if (entry === undefined) return;
  pendingDecisions.delete(permissionRequestId);
  clearTimeout(entry.timer);
  entry.resolve(outcome);
}

function handleBrokerFrame(raw) {
  if (!isPlainObject(raw)) return;
  const id = raw.permissionRequestId;
  if (typeof id !== "string") return;
  if (raw.type === "decision") {
    if (raw.behavior === "allow" && isPlainObject(raw.updatedInput)) {
      settlePending(id, { kind: "allow", updatedInput: raw.updatedInput });
    } else if (raw.behavior === "deny" && typeof raw.message === "string") {
      settlePending(id, { kind: "deny", message: raw.message });
    } else {
      settlePending(id, { kind: "deny", message: "invalid permission decision from bridge" });
    }
    return;
  }
  if (raw.type === "error" && pendingDecisions.has(id)) {
    // Broker-side rejection of this request, correlated by id: deny it
    // (fail closed), surfacing the broker's code and message for diagnosis.
    // The connection stays open — only this call is settled.
    const code = typeof raw.code === "string" ? raw.code : "error";
    const message = typeof raw.message === "string" ? raw.message : "permission broker error";
    settlePending(id, { kind: "deny", message: `bridge_error: ${code}: ${message}` });
  }
  // request_registered needs no adapter action; the decision settles the call.
}

function onBrokerClosed() {
  brokerDead = true;
  brokerSocket = undefined;
  if (pendingDecisions.size > 0) {
    // Decisions can never arrive. Answer nothing and close stdio: Claude
    // Code must observe the pipe close and fail the tool call (fail closed).
    scheduleFatalExit();
  }
}

/** Connect, prove the lease, and return the socket. Rejects on connect
 * failure (ENOENT/ECONNREFUSED) after marking the broker unreachable. */
function connectBroker() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const onConnectError = (error) => {
      socket.destroy();
      brokerDead = true;
      reject(error);
    };
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.off("error", onConnectError);
      socket.on("error", () => {
        /* the close handler performs the fail-closed teardown */
      });
      socket.on("close", onBrokerClosed);
      const decoder = createFrameDecoder();
      socket.on("data", (chunk) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) handleBrokerFrame(frame);
      });
      // First frame: prove the single-use lease. The broker sends no hello
      // ack — a rejected lease simply closes the socket, which lands in
      // onBrokerClosed while the triggering call is still pending.
      socket.write(encodeFrame({ type: "hello", leaseSecret, sessionId }));
      resolve(socket);
    });
  });
}

// ---------------------------------------------------------------------------
// The decide tool
// ---------------------------------------------------------------------------

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function denyResult(message, toolUseId) {
  const decision = { behavior: "deny", message, interrupt: false };
  if (toolUseId !== undefined) decision.toolUseID = toolUseId;
  return textResult(JSON.stringify(decision));
}

async function decide(argumentsRaw) {
  const args = isPlainObject(argumentsRaw) ? argumentsRaw : undefined;
  const toolName = args?.tool_name;
  const input = args?.input;
  const toolUseId = args?.tool_use_id;
  const schemaValid =
    typeof toolName === "string" &&
    toolName !== "" &&
    isPlainObject(input) &&
    (toolUseId === undefined || typeof toolUseId === "string");
  if (!schemaValid) {
    return denyResult("invalid permission request schema", toolUseId);
  }

  if (brokerDead) {
    scheduleFatalExit();
    return denyResult("bridge_unavailable", toolUseId);
  }
  if (brokerSocket === undefined) {
    if (brokerConnectPromise === undefined) {
      brokerConnectPromise = connectBroker();
    }
    try {
      brokerSocket = await brokerConnectPromise;
    } catch {
      // Unreachable bridge (ENOENT/ECONNREFUSED): deny so the model sees a
      // clean refusal, then bring the process down (fail closed). Concurrent
      // callers awaiting the same memoized rejection each get this deny.
      scheduleFatalExit();
      return denyResult("bridge_unavailable", toolUseId);
    }
  }
  const socket = brokerSocket;

  const permissionRequestId = randomUUID();
  let frame;
  try {
    frame = encodeFrame({
      type: "permission_request",
      permissionRequestId,
      toolName,
      input,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
    });
  } catch {
    return denyResult("permission request exceeds the bridge frame limit", toolUseId);
  }

  const outcome = await new Promise((resolve) => {
    const entry = { resolve, timer: undefined };
    pendingDecisions.set(permissionRequestId, entry);
    entry.timer = setTimeout(() => {
      if (pendingDecisions.delete(permissionRequestId)) {
        // The broker owns the real wait and denies on its own timer; firing
        // here means it went silent without closing — deny, drop the socket,
        // fail closed.
        brokerDead = true;
        socket.destroy();
        resolve({ kind: "unavailable" });
      }
    }, hardTimeoutMs);
    entry.timer.unref();
    socket.write(frame);
  });

  if (outcome.kind === "unavailable") {
    scheduleFatalExit();
    return denyResult("bridge_unavailable", toolUseId);
  }
  if (outcome.kind === "allow") {
    const decision = { behavior: "allow", updatedInput: outcome.updatedInput };
    if (toolUseId !== undefined) decision.toolUseID = toolUseId;
    return textResult(JSON.stringify(decision));
  }
  return denyResult(outcome.message, toolUseId);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server({ name: SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Forwards a Claude Code permission prompt to the claude-remote Bridge " +
        "and returns the broker's decision (spec §6.4).",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          input: { type: "object" },
          tool_use_id: { type: "string" },
        },
        required: ["tool_name", "input"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
    };
  }
  return decide(request.params.arguments);
});

// Claude closed the MCP connection (or died): abort still-pending requests
// so the broker denies and journals them, then drop the socket.
server.onclose = () => {
  const socket = brokerSocket;
  if (socket === undefined || socket.destroyed) return;
  for (const permissionRequestId of pendingDecisions.keys()) {
    try {
      socket.write(encodeFrame({ type: "abort", permissionRequestId }));
    } catch {
      break;
    }
  }
  socket.destroy();
};

const transport = new StdioServerTransport();
await server.connect(transport);

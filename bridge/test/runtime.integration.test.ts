/**
 * Runtime integration tests (Task 24, Step 1).
 *
 * Fake-Claude end-to-end coverage of the fully wired Bridge runtime:
 *  - two-layer auth (Access assertion + device pairing/challenge/session);
 *  - project authorization; session create/resume/stop/release;
 *  - permission prompt round trip (allow AND deny) over the real broker
 *    socket, driven by a test-side fake permission adapter;
 *  - message.send dispatching → dispatched → completed with persisted
 *    command.status.changed events delivered over the WebSocket;
 *  - snapshot begin/page/commit with the delivery watermark advancing;
 *  - device revocation closing sockets and denying pending permissions;
 *  - audit trail present and free of raw secrets;
 *  - forced 4410 resync flow (protocol-incompatible replay → snapshot
 *    commit → live events resume);
 *  - §7.6 restart reconciliation of dispatching/dispatched commands;
 *  - graceful shutdown denying pending permissions and ending the active
 *    session interrupted via the stop signal order.
 *
 * The Access verifier is a REAL AccessJwtVerifier fed a locally generated
 * RSA JWKS through the injectable fetcher; the fake-claude fixture plays
 * the Claude CLI through the real process factory (BRIDGE_CLAUDE_BIN).
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import WebSocket from "ws";
import { AccessJwtVerifier, type JwksFetcher } from "../src/auth/access-jwt-verifier.js";
import { buildSigningBytes } from "../src/auth/signing-bytes.js";
import { createDeviceAuth, deviceIdFromSpki } from "../src/auth/device-auth.js";
import { openDatabase } from "../src/db/database.js";
import { encodeProjectPath } from "../src/history/claude-2.1.133-adapter.js";
import { startBridge, type BridgeHandle, type StartBridgeOverrides } from "../src/main.js";
import {
  createFrameDecoder,
  encodeFrame,
  type DecisionFrame,
  type RequestRegisteredFrame,
} from "../src/permissions/socket-protocol.js";
import { PROTOCOL_VERSION } from "../src/protocol/v1/types.js";
import { randomUUID } from "node:crypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const FAKE_CLAUDE = join(here, "fixtures", "fake-claude.sh");
const FAKE_ADAPTER = join(here, "fixtures", "fake-permission-adapter.mjs");

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUDIENCE = "0e9a5b2f7dbf4e1b9a17d8e0c3f2a1b0";
const SUBJECT = "user@example.com";
const KID = "test-kid-1";
const HOST_ASCII = "bridge.example.com";
const V1 = PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// Access verifier fixture (real verifier + local RSA JWKS)
// ---------------------------------------------------------------------------

let verifier: AccessJwtVerifier;

beforeAll(async () => {
  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  const publicJwk = await jose.exportJWK(pair.publicKey);
  const fetcher: JwksFetcher = async () => ({
    keys: [{ ...publicJwk, kid: KID, use: "sig", kty: "RSA", alg: "RS256" }],
  });
  verifier = new AccessJwtVerifier({ teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksFetcher: fetcher });
  signingKey = pair.privateKey;
});

let signingKey: jose.KeyLike;

async function signAssertion(subject = SUBJECT): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({ iss: `https://${TEAM_DOMAIN}`, aud: AUDIENCE, sub: subject, iat: nowSec, exp: nowSec + 3600, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(signingKey);
}

// ---------------------------------------------------------------------------
// Per-test world: temp dirs, env, bridge handle
// ---------------------------------------------------------------------------

interface World {
  dataDir: string;
  configDir: string;
  projectDir: string;
  canonicalProject: string;
  env: Record<string, string | undefined>;
  bridge?: BridgeHandle | undefined;
  baseUrl?: string;
  wsUrl?: string;
}

const worlds: World[] = [];
let world: World;

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

/** Create the temp world; call `boot()` to start a bridge on it. */
async function makeWorld(opts: { noResult?: boolean } = {}): Promise<World> {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-runtime-"));
  const configDir = join(dataDir, ".claude");
  const projectDir = join(dataDir, "proj");
  mkdirSync(projectDir);
  writeFileSync(FAKE_ADAPTER, "// fake MCP adapter entry (never spawned by fake-claude)\nexport {};\n");
  const env: Record<string, string | undefined> = {
    ...process.env,
    BRIDGE_DATA_DIR: dataDir,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(await freePort()),
    BRIDGE_CLAUDE_BIN: FAKE_CLAUDE,
    BRIDGE_PERMISSION_ADAPTER_ENTRY: FAKE_ADAPTER,
    BRIDGE_PUBLIC_HOST: HOST_ASCII,
    CLAUDE_CONFIG_DIR: configDir,
    ...(opts.noResult ? { FAKE_CLAUDE_NO_RESULT: "1" } : {}),
  };
  const w: World = {
    dataDir,
    configDir,
    projectDir,
    canonicalProject: realpathSync(projectDir),
    env,
  };
  worlds.push(w);
  return w;
}

async function boot(w: World = world, overrides: Partial<StartBridgeOverrides> = {}): Promise<BridgeHandle> {
  const bridge = await startBridge(w.env, { accessVerifier: verifier, ...overrides });
  w.bridge = bridge;
  w.baseUrl = `http://127.0.0.1:${bridge.config.port}`;
  w.wsUrl = `${w.baseUrl.replace("http", "ws")}/api/v1/ws`;
  return bridge;
}

beforeEach(() => {
  world = undefined as unknown as World;
});

afterEach(async () => {
  for (const w of worlds.splice(0)) {
    try {
      await w.bridge?.close();
    } catch {
      // best-effort teardown
    }
    // Kill any leaked fake-claude children recorded in session locks.
    try {
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(join(w.dataDir, "bridge.db"), { readonly: true });
      const rows = raw.prepare("SELECT processPid FROM session_locks WHERE processPid IS NOT NULL").all() as Array<{ processPid: number }>;
      raw.close();
      for (const { processPid } of rows) {
        try {
          process.kill(processPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    } catch {
      // database already closed/unavailable
    }
    rmSync(w.dataDir, { recursive: true, force: true });
  }
  delete process.env.FAKE_CLAUDE_NO_RESULT;
});

// ---------------------------------------------------------------------------
// Device client: P-256 key + pairing + challenge/verify over real routes
// ---------------------------------------------------------------------------

interface DeviceClient {
  deviceId: string;
  privateKey: KeyObject;
  deviceSessionToken: string;
  deviceSessionExpiresAt: number;
  assertion: string;
  authHeaders(): Record<string, string>;
  pair(pairingToken: string): Promise<void>;
  authenticate(): Promise<void>;
}

async function makeDeviceClient(): Promise<DeviceClient> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const deviceId = deviceIdFromSpki(spki);
  const client: DeviceClient = {
    deviceId,
    privateKey,
    deviceSessionToken: "",
    deviceSessionExpiresAt: 0,
    assertion: "",
    authHeaders() {
      return {
        "cf-access-jwt-assertion": client.assertion,
        "x-claude-remote-device-session": client.deviceSessionToken,
      };
    },
    async pair(pairingToken: string) {
      client.assertion = await signAssertion();
      const res = await fetch(`${world.baseUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": client.assertion },
        body: JSON.stringify({
          pairingToken,
          publicKeySpkiB64u: spki.toString("base64url"),
          deviceId,
          displayName: "Pixel 9",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deviceId });
    },
    async authenticate() {
      client.assertion = await signAssertion();
      const challengeRes = await fetch(`${world.baseUrl}/api/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": client.assertion },
        body: JSON.stringify({ deviceId }),
      });
      expect(challengeRes.status).toBe(200);
      const challenge = (await challengeRes.json()) as {
        challengeId: string;
        challengeRawB64u: string;
        accessSubject: string;
      };
      const signingBytes = buildSigningBytes({
        hostAscii: HOST_ASCII,
        deviceId,
        challengeId: challenge.challengeId,
        accessSubject: challenge.accessSubject,
        challengeRaw: Buffer.from(challenge.challengeRawB64u, "base64url"),
      });
      const signature = cryptoSign("sha256", signingBytes, privateKey);
      const verifyRes = await fetch(`${world.baseUrl}/api/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": client.assertion },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          accessSubjectEcho: challenge.accessSubject,
          signatureB64u: signature.toString("base64url"),
        }),
      });
      expect(verifyRes.status).toBe(200);
      const session = (await verifyRes.json()) as { deviceSessionToken: string; expiresAt: number };
      client.deviceSessionToken = session.deviceSessionToken;
      client.deviceSessionExpiresAt = session.expiresAt;
    },
  };
  return client;
}

/** Pair + authenticate a device against the booted world. */
async function pairedDevice(): Promise<DeviceClient> {
  const client = await makeDeviceClient();
  const minted = world.bridge!.devices.mintPairingToken(Date.now());
  await client.pair(minted.token);
  await client.authenticate();
  return client;
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

interface CommandResponse {
  status: number;
  body: {
    protocolVersion?: string;
    requestId?: string;
    responseType?: string;
    commandStatus?: string;
    result?: unknown;
    error?: { code: string; message: string; retryable?: boolean };
  };
}

async function httpCommand(
  client: DeviceClient,
  commandType: string,
  payload: unknown,
  opts: { sessionId?: string | null; idempotencyKey?: string; requestId?: string } = {},
): Promise<CommandResponse> {
  const requestId = opts.requestId ?? randomUUID();
  const res = await fetch(`${world.baseUrl}/api/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...client.authHeaders() },
    body: JSON.stringify({
      protocolVersion: V1,
      requestId,
      idempotencyKey: opts.idempotencyKey ?? requestId,
      commandType,
      sessionId: opts.sessionId ?? null,
      sentAt: new Date().toISOString(),
      payload,
    }),
  });
  return { status: res.status, body: (await res.json()) as CommandResponse["body"] };
}

// ---------------------------------------------------------------------------
// WebSocket helper
// ---------------------------------------------------------------------------

interface WsClient {
  ws: WebSocket;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  events: Array<Record<string, unknown>>;
  responses: Array<Record<string, unknown>>;
  sendCommand(commandType: string, payload: unknown, opts?: { requestId?: string; sessionId?: string | null }): string;
  waitForEvent(pred: (e: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForResponse(requestId: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function connectWs(client: DeviceClient, w: World = world): WsClient {
  const ws = new WebSocket(w.wsUrl!, [V1], { headers: client.authHeaders() });
  const out: WsClient = {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    closed: new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))),
    events: [],
    responses: [],
    sendCommand(commandType, payload, opts = {}) {
      const requestId = opts.requestId ?? randomUUID();
      ws.send(
        JSON.stringify({
          protocolVersion: V1,
          requestId,
          idempotencyKey: requestId,
          commandType,
          sessionId: opts.sessionId ?? null,
          sentAt: new Date().toISOString(),
          payload,
        }),
      );
      return requestId;
    },
    async waitForEvent(pred, timeoutMs = 10_000) {
      const existing = out.events.find(pred);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
        const onMessage = (raw: unknown) => {
          const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
          if (parsed.eventType !== undefined && pred(parsed)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(parsed);
          }
        };
        ws.on("message", onMessage);
      });
    },
    async waitForResponse(requestId, timeoutMs = 10_000) {
      const existing = out.responses.find((r) => r.requestId === requestId);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for response ${requestId}`)), timeoutMs);
        const onMessage = (raw: unknown) => {
          const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
          if (parsed.requestId === requestId && parsed.responseType !== undefined) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(parsed);
          }
        };
        ws.on("message", onMessage);
      });
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        await out.closed;
      }
    },
  };
  ws.on("message", (raw) => {
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    if (parsed.responseType !== undefined) out.responses.push(parsed);
    else if (parsed.eventType !== undefined) out.events.push(parsed);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Fake permission adapter socket (talks the real broker socket protocol)
// ---------------------------------------------------------------------------

interface AdapterSocket {
  send(frame: unknown): void;
  nextFrame(timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

async function connectAdapterSocket(sessionId: string): Promise<AdapterSocket> {
  const bridge = world.bridge!;
  const mcpConfigPath = join(bridge.config.dataDir, "mcp", `${sessionId}.json`);
  const mcp = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
    mcpServers: { claude_remote_permission: { env: { BRIDGE_LEASE_SECRET: string } } };
  };
  const socket = net.connect(join(bridge.config.dataDir, "permissions.sock"));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = createFrameDecoder();
  // Simple promise queue: each nextFrame() call is served from `buffered`
  // first, otherwise parked until the next decoded frame.
  const buffered: Array<Record<string, unknown>> = [];
  const parked: Array<(v: Record<string, unknown>) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      const value = frame as Record<string, unknown>;
      const waiter = parked.shift();
      if (waiter) waiter(value);
      else buffered.push(value);
    }
  });
  const out: AdapterSocket = {
    send(frame) {
      socket.write(encodeFrame(frame));
    },
    nextFrame(timeoutMs = 10_000) {
      const bufferedFrame = buffered.shift();
      if (bufferedFrame) return Promise.resolve(bufferedFrame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for broker frame")), timeoutMs);
        parked.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
    close() {
      socket.destroy();
    },
  };
  out.send({
    type: "hello",
    leaseSecret: mcp.mcpServers.claude_remote_permission.env.BRIDGE_LEASE_SECRET,
    sessionId,
  });
  return out;
}

/** Register a permission request; resolves with the broker-assigned id. */
async function requestPermission(adapter: AdapterSocket, toolName: string): Promise<string> {
  adapter.send({ type: "permission_request", toolName, input: { command: "echo hi" } });
  const frame = (await adapter.nextFrame()) as unknown as RequestRegisteredFrame;
  expect(frame.type).toBe("request_registered");
  return frame.permissionRequestId;
}

// ---------------------------------------------------------------------------
// Transcript fixtures
// ---------------------------------------------------------------------------

function transcriptDir(): string {
  return join(world.configDir, "projects", encodeProjectPath(world.canonicalProject));
}

function writeTranscript(sessionId: string, lines: string[]): string {
  const dir = transcriptDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function userLine(uuid: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

function assistantLine(uuid: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  });
}

const TURN_END = JSON.stringify({ type: "system", subtype: "turn_duration", duration_ms: 1 });
const API_ERROR = JSON.stringify({ type: "system", subtype: "api_error", message: "boom" });

/** A transcript with `count` top-level assistant records (→ many history items). */
function manyItemTranscript(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(assistantLine(`a-${i}`));
  return lines;
}

// ---------------------------------------------------------------------------
// Shared setup: booted world + paired device + authorized project + WS
// ---------------------------------------------------------------------------

interface FullWorld {
  bridge: BridgeHandle;
  client: DeviceClient;
  ws: WsClient;
  projectId: string;
}

async function bootFullWorld(): Promise<{ full: Omit<FullWorld, "ws">; ws: WsClient }> {
  world = await makeWorld();
  const bridge = await boot();
  const record = bridge.registry.authorize(world.projectDir, "proj", { now: Date.now() });
  const client = await pairedDevice();
  const ws = connectWs(client);
  await ws.opened;
  return { full: { bridge, client, projectId: record.projectId }, ws };
}

function sessionRow(sessionId: string): { status: string } {
  const row = world.bridge!.db.prepare("SELECT status FROM sessions WHERE sessionId = ?").get(sessionId) as
    | { status: string }
    | undefined;
  if (row === undefined) throw new Error(`unknown session ${sessionId}`);
  return row;
}

function commandRow(requestId: string): { status: string; resultJson: string | null } {
  return world.bridge!.db
    .prepare("SELECT status, resultJson FROM commands WHERE requestId = ?")
    .get(requestId) as { status: string; resultJson: string | null };
}

interface AuditRow {
  operationType: string;
  resultCode: string;
  deviceId: string | null;
  accessSubjectHash: string | null;
  redactedDetail: string | null;
}

function auditRows(operationType: string): AuditRow[] {
  return world.bridge!.db
    .prepare("SELECT operationType, resultCode, deviceId, accessSubjectHash, redactedDetail FROM audit_events WHERE operationType = ? ORDER BY auditId")
    .all(operationType) as AuditRow[];
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout: ${what}`);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("runtime integration (Task 24)", () => {
  it(
    "runs the full end-to-end flow: auth, session lifecycle, permission round trip, command lifecycle, snapshot, audit",
    async () => {
      const { full, ws } = await bootFullWorld();
      const { bridge, client, projectId } = full;

      // --- Project authorization: unknown project is rejected ---------
      const badCreate = await httpCommand(client, "session.create", { projectId: randomUUID() });
      expect(badCreate.status).toBe(404);
      expect(badCreate.body.error?.code).toBe("PROJECT_NOT_FOUND");

      // --- session.create ---------------------------------------------
      const created = await httpCommand(client, "session.create", { projectId, displayName: "work" });
      expect(created.status).toBe(200);
      expect(created.body.responseType).toBe("command.status");
      expect(created.body.commandStatus).toBe("completed");
      const sessionId = (created.body.result as { sessionId: string }).sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(sessionRow(sessionId).status).toBe("idle");

      // --- message.send: dispatching → dispatched → completed ---------
      const sendRequest = randomUUID();
      ws.sendCommand("message.send", { sessionId, text: "hello bridge" }, { sessionId, requestId: sendRequest });
      const sendResponse = await ws.waitForResponse(sendRequest);
      expect(sendResponse.responseType).toBe("command.status");
      expect(sendResponse.commandStatus).toBe("dispatched");

      await waitFor(
        () => commandRow(sendRequest).status === "completed",
        "message.send command completion",
      );
      // The completion was delivered as a persisted command.status.changed
      // event (the dispatching/dispatched transitions carry their own events
      // per §8.3; this waits for the terminal one).
      const completedEvent = await ws.waitForEvent(
        (e) =>
          e.eventType === "command.status.changed" &&
          (e.payload as Record<string, unknown>).requestId === sendRequest &&
          (e.payload as Record<string, unknown>).commandStatus === "completed",
      );
      expect((completedEvent.payload as Record<string, unknown>).commandStatus).toBe("completed");
      // The event row is persisted in pending_events.
      const persisted = bridge.db
        .prepare("SELECT payloadJson FROM pending_events WHERE sessionId = ? AND eventType = 'command.status.changed'")
        .all(sessionId) as Array<{ payloadJson: string }>;
      expect(persisted.some((r) => r.payloadJson.includes(sendRequest))).toBe(true);

      // The session returned to idle after the turn completed.
      await waitFor(() => sessionRow(sessionId).status === "idle", "session idle after turn");
      // An assistant.message.completed event was journaled by the pump.
      const assistantEvent = await ws.waitForEvent((e) => e.eventType === "assistant.message.completed");
      expect(assistantEvent.sessionId).toBe(sessionId);

      // --- session.list / session.state.get ---------------------------
      const list = await httpCommand(client, "session.list", {});
      expect(list.status).toBe(200);
      expect(((list.body.result as { sessions: Array<{ sessionId: string }> }).sessions ?? []).some((s) => s.sessionId === sessionId)).toBe(true);
      const state = await httpCommand(client, "session.state.get", { sessionId }, { sessionId });
      expect(state.body.result).toMatchObject({ sessionId, status: "idle" });

      // --- permission round trip: allow -------------------------------
      const adapter = await connectAdapterSocket(sessionId);
      const allowId = await requestPermission(adapter, "Bash");
      const permissionEvent = await ws.waitForEvent(
        (e) => e.eventType === "permission.requested" && (e.payload as Record<string, unknown>).permissionRequestId === allowId,
      );
      expect((permissionEvent.payload as Record<string, unknown>).toolName).toBe("Bash");
      expect((permissionEvent.payload as Record<string, unknown>).displayCategory).toBe("command_execution");

      const allowResolve = await httpCommand(
        client,
        "permission.resolve",
        { permissionRequestId: allowId, sessionId, decision: "allow" },
        { sessionId },
      );
      expect(allowResolve.status).toBe(200);
      expect(allowResolve.body.commandStatus).toBe("completed");
      const allowDecision = (await adapter.nextFrame()) as unknown as DecisionFrame & {
        updatedInput?: unknown;
      };
      expect(allowDecision.type).toBe("decision");
      expect(allowDecision.behavior).toBe("allow");
      expect(allowDecision.updatedInput).toEqual({ command: "echo hi" });
      const resolvedEvent = await ws.waitForEvent(
        (e) => e.eventType === "permission.resolved" && (e.payload as Record<string, unknown>).permissionRequestId === allowId,
      );
      expect((resolvedEvent.payload as Record<string, unknown>).behavior).toBe("allow");

      // --- permission round trip: deny --------------------------------
      const denyId = await requestPermission(adapter, "Write");
      const denyResolve = await httpCommand(
        client,
        "permission.resolve",
        { permissionRequestId: denyId, sessionId, decision: "deny" },
        { sessionId },
      );
      expect(denyResolve.status).toBe(200);
      const denyDecision = (await adapter.nextFrame()) as unknown as DecisionFrame & {
        interrupt?: boolean;
      };
      expect(denyDecision.behavior).toBe("deny");
      expect(denyDecision.interrupt).toBe(false);
      adapter.close();

      // --- snapshot begin/page/commit (Room-equivalent state machine) --
      writeTranscript(sessionId, manyItemTranscript(25));
      const begin = await httpCommand(client, "session.snapshot.begin", { sessionId }, { sessionId });
      expect(begin.status).toBe(200);
      const beginResult = begin.body.result as {
        snapshotId: string;
        historyRevision: string;
        items: unknown[];
        nextCursor: string | null;
        deliveryWatermark: string;
        sessionStatus: string;
      };
      expect(beginResult.items.length).toBeGreaterThan(0);
      expect(beginResult.nextCursor).toBeTypeOf("string");
      let pageCount = 0;
      let cursor = beginResult.nextCursor;
      const snapshotCommitKey = randomUUID();
      // Page through the whole snapshot.
      for (;;) {
        const page = await httpCommand(client, "session.snapshot.page", { sessionId, cursor: cursor! }, { sessionId });
        expect(page.status).toBe(200);
        pageCount += 1;
        const next = (page.body.result as { nextCursor: string | null }).nextCursor;
        if (next === null) break;
        cursor = next;
      }
      expect(pageCount).toBeGreaterThanOrEqual(1);
      // Consumed cursor: re-using the final (consumed) cursor yields 410.
      const stalePage = await httpCommand(client, "session.snapshot.page", { sessionId, cursor: beginResult.nextCursor! }, { sessionId });
      expect(stalePage.status).toBe(410);

      const commit = await httpCommand(
        client,
        "session.snapshot.commit",
        {
          sessionId,
          snapshotId: beginResult.snapshotId,
          historyRevision: beginResult.historyRevision,
          deliveryWatermark: beginResult.deliveryWatermark,
          idempotencyKey: snapshotCommitKey,
        },
        { sessionId },
      );
      expect(commit.status).toBe(200);
      expect((commit.body.result as Record<string, unknown>).status).toBe("committed");
      // Delivery advanced: an events.ack at the checkpoint watermark is accepted.
      const ack = await httpCommand(
        client,
        "events.ack",
        { sessionId, lastEventId: beginResult.deliveryWatermark },
        { sessionId },
      );
      expect(ack.status).toBe(200);
      // Duplicate commit replays the same result.
      const commitReplay = await httpCommand(
        client,
        "session.snapshot.commit",
        {
          sessionId,
          snapshotId: beginResult.snapshotId,
          historyRevision: beginResult.historyRevision,
          deliveryWatermark: beginResult.deliveryWatermark,
          idempotencyKey: snapshotCommitKey,
        },
        { sessionId },
      );
      expect(commitReplay.status).toBe(200);

      // --- session.stop → interrupted; resume → idle; release ---------
      // §7.5: stop terminates the CURRENT turn; from `idle` it is a 409
      // conflict. The first session's turn already completed (idle), so a
      // second session — whose child is spawned with FAKE_CLAUDE_NO_RESULT=1
      // (inherited at spawn time; the first child predates the change) —
      // holds its turn `running` deterministically.
      process.env.FAKE_CLAUDE_NO_RESULT = "1";
      try {
        const heldCreated = await httpCommand(client, "session.create", { projectId });
        expect(heldCreated.status).toBe(200);
        const stopSessionId = (heldCreated.body.result as { sessionId: string }).sessionId;
        const hold = await httpCommand(
          client,
          "message.send",
          { sessionId: stopSessionId, text: "hold" },
          { sessionId: stopSessionId, idempotencyKey: `hold-${randomUUID()}` },
        );
        expect(hold.body.commandStatus).toBe("dispatched");
        await waitFor(() => sessionRow(stopSessionId).status === "running", "held session running");

        // Stop from idle is the documented conflict (409 SESSION_CONFLICT).
        const idleStop = await httpCommand(client, "session.stop", { sessionId }, { sessionId });
        expect(idleStop.status).toBe(409);
        expect(idleStop.body.error?.code).toBe("SESSION_CONFLICT");

        const stopped = await httpCommand(client, "session.stop", { sessionId: stopSessionId }, { sessionId: stopSessionId });
        expect(stopped.status).toBe(200);
        expect(sessionRow(stopSessionId).status).toBe("interrupted");

        const resumed = await httpCommand(client, "session.resume", { sessionId: stopSessionId }, { sessionId: stopSessionId });
        expect(resumed.status).toBe(200);
        expect(sessionRow(stopSessionId).status).toBe("idle");

        const released = await httpCommand(client, "session.release", { sessionId: stopSessionId }, { sessionId: stopSessionId });
        expect(released.status).toBe(200);
        expect(sessionRow(stopSessionId).status).toBe("inactive");
      } finally {
        delete process.env.FAKE_CLAUDE_NO_RESULT;
      }

      // --- Idempotency: replay returns the saved status; conflict 409 --
      const replayProper = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({
          protocolVersion: V1,
          requestId: list.body.requestId,
          idempotencyKey: list.body.requestId,
          commandType: "session.list",
          sessionId: null,
          sentAt: new Date().toISOString(),
          payload: {},
        }),
      });
      expect(replayProper.status).toBe(200);
      expect((await replayProper.json() as CommandResponse["body"]).commandStatus).toBe("completed");

      const conflict = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({
          protocolVersion: V1,
          requestId: list.body.requestId,
          idempotencyKey: list.body.requestId,
          // Same idempotency key, DIFFERENT (schema-valid) payload: the
          // session.list payload schema is strictly {}, so the conflict probe
          // carries a session.state.get payload instead.
          commandType: "session.state.get",
          sessionId: null,
          sentAt: new Date().toISOString(),
          payload: { sessionId },
        }),
      });
      expect(conflict.status).toBe(409);

      // --- Audit trail: operations recorded, secrets absent -----------
      const auditText = readFileSync(bridge.config.auditLogPath, "utf8");
      expect(auditText).toContain("session.create");
      expect(auditText).toContain("permission.resolve");
      expect(auditText).not.toContain(client.deviceSessionToken);
      expect(auditText).not.toContain(client.assertion);
      const auditRows = bridge.db
        .prepare("SELECT operationType FROM audit_events WHERE operationType = 'message.send'")
        .all() as Array<{ operationType: string }>;
      expect(auditRows.length).toBeGreaterThanOrEqual(1);

      await ws.close();
    },
    60_000,
  );

  it(
    "rejects unauthenticated command and WebSocket access with typed errors",
    async () => {
      world = await makeWorld();
      await boot();
      const client = await pairedDevice();

      // No headers at all.
      const noAuth = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(noAuth.status).toBe(401);

      // Valid assertion, but no device session.
      const noDevice = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signAssertion() },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k2", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(noDevice.status).toBe(401);

      // Valid assertion + garbage device session token.
      const badDevice = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": await signAssertion(),
          "x-claude-remote-device-session": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k3", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(badDevice.status).toBe(401);

      // Assertion signed for a DIFFERENT subject than the paired device:
      // subject mismatch is 403.
      const client2assertion = await signAssertion("other-user@example.com");
      const mismatch = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": client2assertion,
          "x-claude-remote-device-session": client.deviceSessionToken,
        },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k4", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(mismatch.status).toBe(403);

      // WebSocket without headers closes 4401.
      const wsBad = new WebSocket(world.wsUrl!, [V1]);
      const wsBadClosed = new Promise<number>((resolve) => wsBad.once("close", (code) => resolve(code)));
      await new Promise<void>((resolve) => {
        wsBad.once("open", () => resolve());
        wsBad.once("error", () => resolve());
        wsBad.once("close", () => resolve());
      });
      expect(await wsBadClosed).toBe(4401);

      // WebSocket with a bogus device session also closes 4401.
      const wsBad2 = new WebSocket(world.wsUrl!, [V1], {
        headers: { "cf-access-jwt-assertion": await signAssertion(), "x-claude-remote-device-session": "nope" },
      });
      const wsBad2Closed = new Promise<number>((resolve) => wsBad2.once("close", (code) => resolve(code)));
      await new Promise<void>((resolve) => {
        wsBad2.once("open", () => resolve());
        wsBad2.once("error", () => resolve());
        wsBad2.once("close", () => resolve());
      });
      expect(await wsBad2Closed).toBe(4401);

      // A second, DIFFERENT device cannot pair while one is active (403).
      const second = await makeDeviceClient();
      const minted = world.bridge!.devices.mintPairingToken(Date.now());
      second.assertion = await signAssertion();
      const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pairRes = await fetch(`${world.baseUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": second.assertion },
        body: JSON.stringify({
          pairingToken: minted.token,
          publicKeySpkiB64u: spki.toString("base64url"),
          deviceId: deviceIdFromSpki(spki),
        }),
      });
      expect(pairRes.status).toBe(403);
    },
    30_000,
  );

  it(
    "4410 resync: incompatible replay closes 4410; snapshot commit recovers; live events resume",
    async () => {
      const { full, ws } = await bootFullWorld();
      const { client, projectId } = full;
      const created = await httpCommand(client, "session.create", { projectId });
      const sessionId = (created.body.result as { sessionId: string }).sessionId;
      writeTranscript(sessionId, manyItemTranscript(25));

      // Establish a delivery watermark for the device.
      const appended = full.bridge.journal.append({
        category: "system",
        sessionId,
        eventType: "session.state.changed",
        payload: { note: "pre-resync" },
        now: Date.now(),
      });
      const ack = await httpCommand(client, "events.ack", { sessionId, lastEventId: appended.eventId.toString() }, { sessionId });
      expect(ack.status).toBe(200);
      await ws.close();

      // Client state diverges: the next event is written with an
      // incompatible protocol version (as if a Bridge upgrade could not
      // convert it).
      const incompatible = full.bridge.journal.append({
        category: "system",
        sessionId,
        eventType: "session.state.changed",
        payload: { note: "upgraded" },
        now: Date.now(),
      });
      full.bridge.db
        .prepare("UPDATE pending_events SET protocolVersion = ? WHERE sessionId = ? AND eventId = ?")
        .run("claude-remote.v999", sessionId, Number(incompatible.eventId));

      // Reconnect: replay finds the incompatible event → 4410.
      const resyncWs = connectWs(client);
      await resyncWs.opened;
      const closed = await resyncWs.closed;
      expect(closed.code).toBe(4410);

      // Client runs snapshot.begin → page → commit.
      const begin = await httpCommand(client, "session.snapshot.begin", { sessionId }, { sessionId });
      expect(begin.status).toBe(200);
      const beginResult = begin.body.result as { snapshotId: string; historyRevision: string; nextCursor: string | null; deliveryWatermark: string };
      let cursor = beginResult.nextCursor;
      while (cursor !== null) {
        const page = await httpCommand(client, "session.snapshot.page", { sessionId, cursor }, { sessionId });
        expect(page.status).toBe(200);
        cursor = (page.body.result as { nextCursor: string | null }).nextCursor;
      }
      const commit = await httpCommand(client, "session.snapshot.commit", {
        sessionId,
        snapshotId: beginResult.snapshotId,
        historyRevision: beginResult.historyRevision,
        deliveryWatermark: beginResult.deliveryWatermark,
        idempotencyKey: randomUUID(),
      }, { sessionId });
      expect(commit.status).toBe(200);

      // Reconnect: replay is past the incompatible event; the socket stays
      // open and live events with eventId > deliveryWatermark apply without
      // re-triggering 4410.
      const liveWs = connectWs(client);
      await liveWs.opened;
      const liveEvent = full.bridge.journal.append({
        category: "system",
        sessionId,
        eventType: "session.state.changed",
        payload: { note: "post-commit live" },
        now: Date.now(),
      });
      const received = await liveWs.waitForEvent(
        (e) => e.eventType === "session.state.changed" && (e.payload as Record<string, unknown>).note === "post-commit live",
      );
      expect(received.eventId).toBe(liveEvent.eventId.toString());
      // Still open (no 4410).
      expect(liveWs.ws.readyState).toBe(WebSocket.OPEN);
      await liveWs.close();
    },
    30_000,
  );

  it(
    "§7.6 restart reconciliation classifies dispatching/dispatched commands per transcript evidence",
    async () => {
      world = await makeWorld();
      const bridge1 = await boot();
      const record = bridge1.registry.authorize(world.projectDir, "proj", { now: Date.now() });
      const client = await pairedDevice();
      const created = await httpCommand(client, "session.create", { projectId: record.projectId });
      expect(created.status).toBe(200);
      const sessionId = (created.body.result as { sessionId: string }).sessionId;
      // A SECOND session carries the incompatible-evidence case: a malformed
      // line is file-global in findTurnEvidence, so it must live in its own
      // transcript to avoid poisoning the other evidence.
      const createdB = await httpCommand(client, "session.create", { projectId: record.projectId });
      expect(createdB.status).toBe(200);
      const sessionB = (createdB.body.result as { sessionId: string }).sessionId;

      // Simulate a bridge kill mid-turn: sessions running with commands in
      // dispatching/dispatched states, plus per-evidence transcripts.
      const completedReq = randomUUID();
      const failedReq = randomUUID();
      const interruptedReq = randomUUID();
      const absentReq = randomUUID();
      const incompatibleReq = randomUUID();
      const dispatchingReq = randomUUID();
      const insert = bridge1.db.prepare(
        `INSERT INTO commands (requestId, deviceId, sessionId, idempotencyKey, commandType, payloadHash, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'message.send', 'hash', ?, ?, ?)`,
      );
      const t = Date.now();
      insert.run(completedReq, client.deviceId, sessionId, `k-${completedReq}`, "dispatched", t, t);
      insert.run(failedReq, client.deviceId, sessionId, `k-${failedReq}`, "dispatched", t, t);
      insert.run(interruptedReq, client.deviceId, sessionId, `k-${interruptedReq}`, "dispatched", t, t);
      insert.run(absentReq, client.deviceId, sessionId, `k-${absentReq}`, "dispatched", t, t);
      insert.run(dispatchingReq, client.deviceId, sessionId, `k-${dispatchingReq}`, "dispatching", t, t);
      insert.run(incompatibleReq, client.deviceId, sessionB, `k-${incompatibleReq}`, "dispatched", t, t);
      const setRunning = bridge1.db.prepare("UPDATE sessions SET status = 'running' WHERE sessionId = ?");
      setRunning.run(sessionId);
      setRunning.run(sessionB);

      // The real fake-claude children from session.create: captured now so
      // the test can guarantee cleanup (bridge2's lock expiry cannot kill
      // them — production omits the process controller on purpose).
      const childPids = (
        bridge1.db
          .prepare("SELECT processPid FROM session_locks WHERE processPid IS NOT NULL")
          .all() as Array<{ processPid: number }>
      ).map((r) => r.processPid);

      // Transcript A carries clean turn evidence:
      //  - completedReq: full turn (user + assistant + turn end)
      //  - failedReq: turn ending in an api_error
      //  - interruptedReq: user record with NO turn end after it
      //  - absentReq: no transcript record at all
      writeTranscript(sessionId, [
        userLine(completedReq),
        assistantLine(`a-${completedReq}`),
        TURN_END,
        userLine(failedReq),
        assistantLine(`a-${failedReq}`),
        API_ERROR,
        userLine(interruptedReq),
      ]);
      // Transcript B is unparseable after the user record → incompatible.
      writeTranscript(sessionB, [userLine(incompatibleReq), "{ this is not json"]);

      // "Kill" the bridge: start a second instance on the same data dir
      // WITHOUT closing the first (a graceful close would stop the session).
      const port2 = await freePort();
      const bridge2 = await startBridge(
        { ...world.env, BRIDGE_PORT: String(port2) },
        { accessVerifier: verifier },
      );
      // The second instance adopts the same world for helpers.
      world.bridge = bridge2;

      // recoverOnStartup: running → interrupted for BOTH sessions.
      const statuses = bridge2.db
        .prepare("SELECT sessionId, status FROM sessions WHERE sessionId IN (?, ?)")
        .all(sessionId, sessionB) as Array<{ sessionId: string; status: string }>;
      expect(statuses.map((s) => s.status)).toEqual(["interrupted", "interrupted"]);

      // Reconciliation outcomes per transcript evidence.
      expect(commandRow(completedReq).status).toBe("completed");
      expect(commandRow(failedReq).status).toBe("failed");
      expect(commandRow(interruptedReq).status).toBe("interrupted");
      expect(commandRow(absentReq).status).toBe("indeterminate");
      expect(commandRow(incompatibleReq).status).toBe("indeterminate");
      expect(commandRow(dispatchingReq).status).toBe("indeterminate");

      // command.status.changed events were persisted for the classified ones.
      const events = bridge2.db
        .prepare("SELECT payloadJson FROM pending_events WHERE eventType = 'command.status.changed'")
        .all() as Array<{ payloadJson: string }>;
      expect(events.some((e) => e.payloadJson.includes(completedReq))).toBe(true);
      expect(events.some((e) => e.payloadJson.includes(failedReq))).toBe(true);

      // Clean up: close bridge2 (already recovered the world), close bridge1's
      // handles (its session rows are interrupted, so its stops are guarded
      // no-ops), and kill any orphaned fake-claude children outright.
      await bridge2.close();
      await bridge1.close();
      for (const pid of childPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    },
    60_000,
  );

  it(
    "graceful shutdown denies pending permissions and ends the active session interrupted",
    async () => {
      process.env.FAKE_CLAUDE_NO_RESULT = "1";
      world = await makeWorld({ noResult: true });
      const bridge = await boot();
      const record = bridge.registry.authorize(world.projectDir, "proj", { now: Date.now() });
      const client = await pairedDevice();
      const ws = connectWs(client);
      await ws.opened;

      const created = await httpCommand(client, "session.create", { projectId: record.projectId });
      const sessionId = (created.body.result as { sessionId: string }).sessionId;

      // A turn that never completes: session goes running and stays there.
      const sendRequest = randomUUID();
      await httpCommand(client, "message.send", { sessionId, text: "hold" }, { sessionId, idempotencyKey: sendRequest });
      await waitFor(() => sessionRow(sessionId).status === "running", "session running");

      // A pending permission keeps the session in waiting_permission.
      const adapter = await connectAdapterSocket(sessionId);
      await requestPermission(adapter, "Bash");
      await waitFor(() => sessionRow(sessionId).status === "waiting_permission", "session waiting_permission");

      // Capture the running child's PID so its death can be asserted.
      const lockRow = bridge.db
        .prepare("SELECT processPid FROM session_locks WHERE sessionId = ?")
        .get(sessionId) as { processPid: number } | undefined;
      expect(lockRow?.processPid).toBeGreaterThan(0);
      const childPid = lockRow!.processPid;

      // SIGTERM path = handle.close(): pending permission denied FIRST...
      await bridge.close();
      const decision = (await adapter.nextFrame()) as unknown as DecisionFrame;
      expect(decision.type).toBe("decision");
      expect(decision.behavior).toBe("deny");
      adapter.close();

      // ...then the stop signal order ends the session interrupted.
      expect(sessionRow(sessionId).status).toBe("interrupted");
      // The fake-claude child is actually gone.
      expect(() => process.kill(childPid, 0)).toThrow();
      // The still-open WebSocket was closed by the shutdown.
      const wsClosed = await ws.closed;
      expect([4500, 1005, 1006]).toContain(wsClosed.code);

      // close() is idempotent.
      await bridge.close();
      // prevent afterEach double-close of the already-closed bridge
      world.bridge = undefined;
    },
    60_000,
  );

  it(
    "device revocation closes the device's sockets and denies its pending permissions",
    async () => {
      const { full, ws } = await bootFullWorld();
      const { bridge, client, projectId } = full;
      const created = await httpCommand(client, "session.create", { projectId });
      const sessionId = (created.body.result as { sessionId: string }).sessionId;

      // Session must be running for a permission to make it waiting; with a
      // completed turn it is idle, but the broker still accepts requests.
      const adapter = await connectAdapterSocket(sessionId);
      await requestPermission(adapter, "Bash");

      bridge.revokeDevice(client.deviceId);

      // The device's WebSocket is closed by the revocation.
      const closed = await ws.closed;
      expect(closed.code).toBe(4401);

      // The pending permission was denied (decision frame on the adapter
      // socket).
      const decision = (await adapter.nextFrame()) as unknown as DecisionFrame;
      expect(decision.behavior).toBe("deny");
      adapter.close();

      // The device session no longer authenticates.
      const after = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: randomUUID(), commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(after.status).toBe(401);
    },
    30_000,
  );

  it(
    "§7.4 retry_indeterminate re-dispatches with the ORIGINAL uuid and payload",
    async () => {
      // Phase 1 (FAKE_CLAUDE_NO_RESULT=1): the first message holds the turn
      // open, so a second message.send is REJECTED while running — the §7.4
      // "the write failed, the turn may or may not have reached Claude" case.
      process.env.FAKE_CLAUDE_NO_RESULT = "1";
      world = await makeWorld({ noResult: true });
      const bridge = await boot();
      const record = bridge.registry.authorize(world.projectDir, "proj", { now: Date.now() });
      const client = await pairedDevice();

      const created = await httpCommand(client, "session.create", { projectId: record.projectId });
      expect(created.status).toBe(200);
      const sessionId = (created.body.result as { sessionId: string }).sessionId;

      // R1 holds the turn open (running forever under NO_RESULT).
      const hold = await httpCommand(client, "message.send", { sessionId, text: "hold" }, { sessionId });
      expect(hold.status).toBe(200);
      await waitFor(() => sessionRow(sessionId).status === "running", "session running");

      // R2 is rejected mid-dispatch: the row must settle at INDETERMINATE
      // (never failed — that is exactly what retry_indeterminate targets).
      const retriedId = randomUUID();
      const rejected = await httpCommand(
        client,
        "message.send",
        { sessionId, text: "retry me 原本文本" },
        { sessionId, requestId: retriedId },
      );
      expect(rejected.status).toBe(409);
      expect((rejected.body.error as { code: string }).code).toBe("SESSION_CONFLICT");
      await waitFor(() => commandRow(retriedId).status === "indeterminate", "command indeterminate");

      // Stop the held turn, then drop NO_RESULT so the NEXT spawned child
      // emits result records (children read FAKE_CLAUDE_NO_RESULT at spawn).
      const stopped = await httpCommand(client, "session.stop", { sessionId }, { sessionId });
      expect(stopped.status).toBe(200);
      await waitFor(() => sessionRow(sessionId).status === "interrupted", "session interrupted");
      delete process.env.FAKE_CLAUDE_NO_RESULT;
      const resumed = await httpCommand(client, "session.resume", { sessionId }, { sessionId });
      expect(resumed.status).toBe(200);
      await waitFor(() => sessionRow(sessionId).status === "idle", "session idle after resume");

      // §7.4: the retry re-dispatches the ORIGINAL requestId + payload.
      const retry = await httpCommand(client, "command.retry_indeterminate", { requestId: retriedId });
      expect(retry.status).toBe(200);
      expect(retry.body.responseType).toBe("command.status");
      expect(retry.body.result).toEqual({ requestId: retriedId, status: "dispatched" });

      // fake-claude records the stdin uuid: it echoes the user record and the
      // assistant record with `assistant-<uuid>`. The pump journals that
      // assistant record — proving the re-send carried the ORIGINAL uuid (a
      // fresh UUID would appear here instead and the turn below would never
      // bind to this command row).
      await waitFor(() => commandRow(retriedId).status === "completed", "retried command completed");
      const assistantEvents = world.bridge!.db
        .prepare("SELECT payloadJson FROM pending_events WHERE sessionId = ? AND eventType = 'assistant.message.completed'")
        .all(sessionId) as Array<{ payloadJson: string }>;
      expect(assistantEvents.some((e) => e.payloadJson.includes(`assistant-${retriedId}`))).toBe(true);
      // (The waitFor above IS the binding proof: the pump completes the
      // command keyed by the echoed user uuid — a fresh UUID would have left
      // the row dispatched forever.)
      // Retrying an already-classified command is the read-only no-op.
      const again = await httpCommand(client, "command.retry_indeterminate", { requestId: retriedId });
      expect(again.status).toBe(200);
      expect(again.body.result).toEqual({ requestId: retriedId, status: "completed" });
    },
    30_000,
  );

  it(
    "§10.4 revocation poller applies a CLI-process revocation within one interval",
    async () => {
      world = await makeWorld();
      const bridge = await boot(world, { revocationPollIntervalMs: 60 });
      bridge.registry.authorize(world.projectDir, "proj", { now: Date.now() });
      const client = await pairedDevice();
      const ws = connectWs(client);
      await ws.opened;
      // `opened` fires at upgrade time, before async authentication settles;
      // a command round trip proves the connection is registered server-side
      // (otherwise a racing revoke would close via the auth path instead).
      const listId = ws.sendCommand("session.list", {});
      const listRes = await ws.waitForResponse(listId);
      expect(listRes.responseType).toBe("command.status");

      // Simulate the admin CLI: a SEPARATE process revokes through its own
      // database handle, whose no-op hooks cannot reach this bridge's
      // sockets — only the poller can.
      const cliDb = openDatabase(join(world.dataDir, "bridge.db"));
      const cliDevices = createDeviceAuth(cliDb);
      cliDevices.revokeDevice(client.deviceId, Date.now(), {
        denyPendingPermissions: () => undefined,
        closeSockets: () => undefined,
      });
      cliDb.close();

      // The poller notices revokedAt and closes the socket 4401.
      const closed = await ws.closed;
      expect(closed.code).toBe(4401);
      expect(closed.reason).toBe("device revoked");

      // The device session no longer authenticates.
      const after = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: randomUUID(), commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(after.status).toBe(401);
    },
    30_000,
  );

  it(
    "§10.6 audits pairing, challenges, verification, command denials, WS denials, and revocation",
    async () => {
      world = await makeWorld();
      const bridge = await boot();
      bridge.registry.authorize(world.projectDir, "proj", { now: Date.now() });
      const client = await pairedDevice(); // → auth.pair ok, auth.challenge ok, auth.verify ok

      // Pairing with a garbage token → 401 + invalid_pairing_token.
      const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const badSpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const badToken = await fetch(`${world.baseUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signAssertion() },
        body: JSON.stringify({
          pairingToken: "garbage-token",
          publicKeySpkiB64u: badSpki.toString("base64url"),
          deviceId: deviceIdFromSpki(badSpki),
        }),
      });
      expect(badToken.status).toBe(401);

      // A second, DIFFERENT device → 403 + one_device_limit.
      const minted = bridge.devices.mintPairingToken(Date.now());
      const secondPair = await fetch(`${world.baseUrl}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signAssertion() },
        body: JSON.stringify({
          pairingToken: minted.token,
          publicKeySpkiB64u: badSpki.toString("base64url"),
          deviceId: deviceIdFromSpki(badSpki),
        }),
      });
      expect(secondPair.status).toBe(403);

      // Challenge for an unknown device → 401; the audit must NOT name the
      // sub-failure (uniform-failure).
      const unknownChallenge = await fetch(`${world.baseUrl}/api/v1/auth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signAssertion() },
        body: JSON.stringify({ deviceId: randomUUID() }),
      });
      expect(unknownChallenge.status).toBe(401);

      // Verify with a garbage challenge → 401 + uniform-failure.
      const badVerify = await fetch(`${world.baseUrl}/api/v1/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signAssertion() },
        body: JSON.stringify({ challengeId: "nope", accessSubjectEcho: SUBJECT, signatureB64u: "AAAA" }),
      });
      expect(badVerify.status).toBe(401);

      // /commands with no auth → 401; with a mismatched subject → 403.
      const noAuth = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(noAuth.status).toBe(401);
      const mismatch = await fetch(`${world.baseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": await signAssertion("other-user@example.com"),
          "x-claude-remote-device-session": client.deviceSessionToken,
        },
        body: JSON.stringify({ protocolVersion: V1, requestId: randomUUID(), idempotencyKey: "k2", commandType: "session.list", sessionId: null, sentAt: new Date().toISOString(), payload: {} }),
      });
      expect(mismatch.status).toBe(403);

      // WebSocket with a bogus device session → 4401 + auth.ws.
      const wsBad = new WebSocket(world.wsUrl!, [V1], {
        headers: { "cf-access-jwt-assertion": await signAssertion(), "x-claude-remote-device-session": "nope" },
      });
      const wsBadClosed = new Promise<number>((resolve) => wsBad.once("close", (code) => resolve(code)));
      await new Promise<void>((resolve) => {
        wsBad.once("open", () => resolve());
        wsBad.once("error", () => resolve());
        wsBad.once("close", () => resolve());
      });
      expect(await wsBadClosed).toBe(4401);
      await waitFor(() => auditRows("auth.ws").length > 0, "auth.ws audit row");

      // Runtime revocation → device.revoke.
      bridge.revokeDevice(client.deviceId);
      await waitFor(() => auditRows("device.revoke").length > 0, "device.revoke audit row");

      // --- audit trail assertions (audit_events, insertion order) ---------
      expect(auditRows("auth.pair").map((r) => r.resultCode)).toEqual([
        "ok",
        "invalid_pairing_token",
        "one_device_limit",
      ]);
      const pairOk = auditRows("auth.pair")[0]!;
      expect(pairOk.deviceId).toBe(client.deviceId);
      expect(pairOk.accessSubjectHash).toBeTruthy();
      expect(auditRows("auth.challenge").map((r) => r.resultCode)).toEqual(["ok", "uniform-failure"]);
      expect(auditRows("auth.verify").map((r) => r.resultCode)).toEqual(["ok", "uniform-failure"]);
      expect(auditRows("auth.request").map((r) => r.resultCode)).toEqual(["unauthorized", "subject_mismatch"]);
      expect(auditRows("auth.ws").map((r) => r.resultCode)).toEqual(["unauthorized"]);
      expect(auditRows("device.revoke").map((r) => r.resultCode)).toEqual(["ok"]);
      expect(auditRows("device.revoke")[0]!.deviceId).toBe(client.deviceId);

      // The JSONL trail carries the same operations — and never a token or
      // assertion value (§10.6 redaction).
      const trail = readFileSync(join(world.dataDir, "audit.jsonl"), "utf8");
      const trailOps = trail
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { operationType: string }).operationType);
      for (const op of ["auth.pair", "auth.challenge", "auth.verify", "auth.request", "auth.ws", "device.revoke"]) {
        expect(trailOps).toContain(op);
      }
      expect(trail).not.toContain(client.deviceSessionToken);
      expect(trail).not.toContain(client.assertion);
    },
    30_000,
  );

  it(
    "§6.6 session.scan_imports and session.import bind foreign transcripts over the wire",
    async () => {
      const { full } = await bootFullWorld();
      const { client, projectId } = full;

      // Foreign transcripts in the project's transcript directory: one clean
      // UUID-named session, one non-UUID file, one non-jsonl file.
      const foreign = randomUUID();
      writeTranscript(foreign, [userLine("u-1"), assistantLine("a-1"), TURN_END]);
      writeFileSync(join(transcriptDir(), "not-a-uuid.jsonl"), "{}\n");
      writeFileSync(join(transcriptDir(), "notes.txt"), "not a transcript\n");

      // scan_imports: candidates + skipped counts, nothing imported yet.
      const scan = await httpCommand(client, "session.scan_imports", { projectId });
      expect(scan.status).toBe(200);
      const scanResult = scan.body.result as {
        candidates: Array<{ sessionId: string; importable: boolean; title: string | null }>;
        skipped: number;
      };
      expect(scanResult.skipped).toBe(2);
      const candidate = scanResult.candidates.find((c) => c.sessionId === foreign);
      expect(candidate).toMatchObject({ sessionId: foreign, importable: true, title: null });

      // import: binds the session to THIS project, source imported.
      const imported = await httpCommand(client, "session.import", { projectId, sessionId: foreign });
      expect(imported.status).toBe(200);
      expect(imported.body.result).toMatchObject({ sessionId: foreign, projectId, created: true });
      const row = full.bridge.db
        .prepare("SELECT projectId, status, source FROM sessions WHERE sessionId = ?")
        .get(foreign) as { projectId: string; status: string; source: string };
      expect(row).toEqual({ projectId, status: "inactive", source: "imported" });

      // Duplicate import is the dedup no-op.
      const again = await httpCommand(client, "session.import", { projectId, sessionId: foreign });
      expect(again.status).toBe(200);
      expect((again.body.result as { created: boolean }).created).toBe(false);

      // A DIFFERENT project cannot adopt the bound session.
      mkdirSync(join(world.dataDir, "proj2"));
      const second = full.bridge.registry.authorize(join(world.dataDir, "proj2"), "proj2", { now: Date.now() });
      const cross = await httpCommand(client, "session.import", { projectId: second.projectId, sessionId: foreign });
      expect(cross.status).toBe(409);
      expect((cross.body.error as { code: string }).code).toBe("SESSION_PROJECT_MISMATCH");

      // Non-UUID sessionIds never reach the dispatcher: the protocol schema
      // rejects them with a typed 400.
      const bad = await httpCommand(client, "session.import", { projectId, sessionId: "not-a-uuid" });
      expect(bad.status).toBe(400);
      expect((bad.body.error as { code: string }).code).toBe("INVALID_COMMAND");

      // Both commands audited (§10.6); failures carry the typed error code
      // (schema rejections happen before dispatch and audit nothing).
      expect(auditRows("session.scan_imports").map((r) => r.resultCode)).toEqual(["ok"]);
      expect(auditRows("session.import").map((r) => r.resultCode)).toEqual([
        "ok",
        "ok",
        "SESSION_PROJECT_MISMATCH",
      ]);
    },
    30_000,
  );
});

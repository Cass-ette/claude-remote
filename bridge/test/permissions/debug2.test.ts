import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { createEventJournal } from "../../src/events/event-journal.js";
import { createPermissionBroker } from "../../src/permissions/permission-broker.js";
import { createFrameDecoder, encodeFrame, type BrokerFrame } from "../../src/permissions/socket-protocol.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SECRET_A = "a".repeat(64);
let dir: string; let socketPath: string; let db: SqliteDatabase; let broker: any;
let adapterSock: net.Socket;
let decoder = createFrameDecoder();
const frames: BrokerFrame[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perm-debug2-"));
  socketPath = join(dir, "perm.sock");
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
  db.prepare(`INSERT INTO projects (projectId, canonicalRealpath, deviceNumber, inode, displayName, createdAt, authorizedAt)
     VALUES ('proj-1', '/tmp/p', 1, 2, 'p', 0, 0)`).run();
  db.prepare(`INSERT INTO sessions (sessionId, projectId, displayName, status, source, lastActivityAt, createdAt)
     VALUES (?, 'proj-1', 'a', 'idle', 'bridge', 0, 0)`).run(SESSION_A);
  const journal = createEventJournal(db, { retentionMs: 600000, byteBudget: 1 << 26 });
  broker = createPermissionBroker({
    journal, socketPath, timeoutMs: 60000,
    activeDeviceForSession: () => "dev",
    terminateSessionProcess: (s: string, r: string) => console.log("TERMINATE", s, r),
    generateId: (() => { let n = 0; return () => `perm-${++n}`; })(),
  });
});

afterEach(async () => {
  adapterSock?.destroy();
  await broker?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("debug area10 flow", async () => {
  await broker.listen();
  broker.registerLease(SECRET_A, SESSION_A);
  adapterSock = net.connect(socketPath);
  adapterSock.on("data", (c: Buffer) => { for (const f of decoder.push(c)) { console.log("GOT FRAME:", JSON.stringify(f)); frames.push(f as BrokerFrame); } });
  adapterSock.on("close", () => console.log("SOCKET CLOSED"));
  adapterSock.on("error", (e) => console.log("SOCKET ERROR", e.message));
  await new Promise<void>((r) => adapterSock.once("connect", r));
  adapterSock.write(encodeFrame({ type: "hello", leaseSecret: SECRET_A, sessionId: SESSION_A }));
  await new Promise((r) => setTimeout(r, 50));

  console.log("STEP1 request");
  const p1 = broker.request({ sessionId: SESSION_A, toolName: "Bash", input: { a: 1 } });
  await new Promise((r) => setTimeout(r, 50));
  console.log("STEP2 resolve allow");
  await broker.resolve({ permissionRequestId: "perm-1", sessionId: SESSION_A, deviceId: "dev", decision: { behavior: "allow" } });
  console.log("STEP3 decision:", JSON.stringify(await p1));
  await new Promise((r) => setTimeout(r, 100));
  console.log("STEP4 frames:", frames.map((f) => f.type).join(","));
  expect(frames.length).toBe(2);
});

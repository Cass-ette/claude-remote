import { pathToFileURL } from "node:url";
import { loadConfig, PENDING_EVENT_RETENTION_SECONDS, SIGNAL_WAIT_SECONDS, type BridgeConfig, type EnvSource } from "./config.js";
import { migrate, openDatabase, type SqliteDatabase } from "./db/database.js";
import { createEventJournal, type EventJournal } from "./events/event-journal.js";
import { createCommandLedger, type CommandLedger } from "./commands/command-ledger.js";
import { startHttpServer } from "./server/http-server.js";
import { registerWebSocket, CLOSE_CODE, type WebSocketService } from "./server/websocket-server.js";
import type { FastifyInstance } from "fastify";

/**
 * Bridge entry point.
 *
 * SECURITY: the Bridge binds to loopback only (enforced by loadConfig).
 * It NEVER starts a Cloudflare Tunnel itself — the tunnel connector runs
 * as a separate, user-managed process per the architecture spec.
 *
 * The audit log (Chunk 3, Task 22) is deliberately not wired here yet;
 * only the components that exist today are composed.
 */
export interface BridgeHandle {
  readonly config: BridgeConfig;
  readonly app: FastifyInstance;
  readonly wsService: WebSocketService;
  readonly db: SqliteDatabase;
  readonly journal: EventJournal;
  readonly ledger: CommandLedger;
  /** Graceful shutdown: close WS clients, HTTP server, then the database. */
  close(): Promise<void>;
}

export async function startBridge(env: EnvSource): Promise<BridgeHandle> {
  const config = loadConfig(env);

  const db = openDatabase(config.databasePath, { createDir: false });
  migrate(db);

  const journal = createEventJournal(db, {
    retentionMs: PENDING_EVENT_RETENTION_SECONDS * 1000,
    byteBudget: config.pendingEventsByteBudget,
  });
  const ledger = createCommandLedger(db, journal);

  const app = startHttpServer(config, {});
  const wsService = registerWebSocket(app, {});

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port }, "bridge listening");

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // No §8.1 code means "clean server shutdown"; 4500 (internal error)
    // is the least-wrong documented code — the socket close is immediate
    // and the client is expected to reconnect and resync.
    wsService.closeAll(CLOSE_CODE.INTERNAL_ERROR, "bridge shutdown");
    try {
      await app.close();
    } finally {
      db.close();
    }
  };

  return { config, app, wsService, db, journal, ledger, close };
}

async function main(): Promise<void> {
  const bridge = await startBridge(process.env);

  const shutdown = (signal: string) => {
    bridge.app.log.info({ signal }, "shutting down");
    void bridge
      .close()
      .catch((err: unknown) => {
        bridge.app.log.error({ err }, "error during close");
      })
      .finally(() => {
        setTimeout(() => process.exit(0), 0).unref();
      });
    // Force-exit if graceful close exceeds SIGNAL_WAIT_SECONDS.
    setTimeout(() => process.exit(0), SIGNAL_WAIT_SECONDS * 1000).unref();
  };

  // process.once (not .on): a second signal falls through to the default
  // hard-exit, which is the intended escape hatch during a hung graceful close.
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("bridge failed to start:", err);
    process.exit(1);
  });
}

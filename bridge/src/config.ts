import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Bridge configuration.
 *
 * SECURITY INVARIANT: the Bridge binds to loopback only (`127.0.0.1` or
 * `::1`). Remote connectivity is provided exclusively by an externally
 * managed Cloudflare Tunnel connector process; the Bridge itself must
 * never listen on a non-loopback interface.
 */
export interface BridgeConfig {
  /** Loopback address the HTTP/WS server binds to. */
  readonly host: "127.0.0.1" | "::1";
  /** Listen port. Privileged ports (<1024) and port 0 are rejected. */
  readonly port: number;
  /** Absolute path of the Bridge data directory (created with mode 0o700). */
  readonly dataDir: string;
  /** SQLite database file inside {@link BridgeConfig.dataDir}. */
  readonly databasePath: string;
  /** Append-only audit log file inside {@link BridgeConfig.dataDir}. */
  readonly auditLogPath: string;
  /** Byte budget for pending (undelivered) events per session fan-out. */
  readonly pendingEventsByteBudget: number;
}

/** Loopback hosts the Bridge is allowed to bind to. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 43111;

/**
 * How long undelivered pending events are retained before deletion.
 * Used by the pending-event persistence layer (later task).
 */
export const PENDING_EVENT_RETENTION_SECONDS = 600;

/**
 * Hard cap on the size of a single tool output payload accepted from
 * Claude Code (prevents unbounded DB rows). Used by the stream adapter.
 */
export const TOOL_OUTPUT_BYTE_LIMIT = 65536;

/** Default pending-events byte budget: 64 MiB. */
export const PENDING_EVENTS_BYTE_BUDGET_DEFAULT = 64 * 1024 * 1024;

/**
 * Seconds to wait for in-flight work after receiving SIGTERM/SIGINT
 * before forcing shutdown. Used by main.ts and the session supervisor.
 */
export const SIGNAL_WAIT_SECONDS = 5;

export type EnvSource = Record<string, string | undefined>;

function readString(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseHost(env: EnvSource): "127.0.0.1" | "::1" {
  const host = readString(env, "BRIDGE_HOST") ?? DEFAULT_BRIDGE_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    // "localhost" is deliberately rejected too: it can resolve to a
    // non-loopback address depending on resolver configuration, and the
    // config layer must never depend on DNS.
    throw new Error(
      `BRIDGE_HOST must be a loopback address (127.0.0.1 or ::1); got ${JSON.stringify(host)}. ` +
        "The Bridge never binds to non-loopback interfaces; remote access goes through the external Cloudflare Tunnel.",
    );
  }
  return host as "127.0.0.1" | "::1";
}

function parsePort(env: EnvSource): number {
  const raw = readString(env, "BRIDGE_PORT") ?? String(DEFAULT_BRIDGE_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`BRIDGE_PORT must be an integer between 1024 and 65535; got ${JSON.stringify(raw)}.`);
  }
  return port;
}

function parseDataDir(env: EnvSource): string {
  const dir = readString(env, "BRIDGE_DATA_DIR");
  if (dir === undefined) {
    throw new Error("BRIDGE_DATA_DIR is required and must be an absolute path.");
  }
  if (!isAbsolute(dir)) {
    throw new Error(`BRIDGE_DATA_DIR must be an absolute path; got ${JSON.stringify(dir)}.`);
  }
  return dir;
}

function parsePendingEventsByteBudget(env: EnvSource): number {
  const raw = readString(env, "BRIDGE_PENDING_EVENTS_BYTE_BUDGET");
  if (raw === undefined) return PENDING_EVENTS_BYTE_BUDGET_DEFAULT;
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget <= 0 || budget > 2 ** 31 - 1) {
    throw new Error(
      `BRIDGE_PENDING_EVENTS_BYTE_BUDGET must be a positive integer (bytes); got ${JSON.stringify(raw)}.`,
    );
  }
  return budget;
}

/**
 * Validate environment variables and produce an immutable
 * {@link BridgeConfig}. Creates {@link BRIDGE_DATA_DIR} recursively with
 * owner-only permissions after validation succeeds.
 */
export function loadConfig(env: EnvSource): BridgeConfig {
  const host = parseHost(env);
  const port = parsePort(env);
  const dataDir = parseDataDir(env);
  const pendingEventsByteBudget = parsePendingEventsByteBudget(env);

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return Object.freeze({
    host,
    port,
    dataDir,
    databasePath: join(dataDir, "bridge.db"),
    auditLogPath: join(dataDir, "audit.jsonl"),
    pendingEventsByteBudget,
  });
}

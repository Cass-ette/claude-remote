import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { normalizeTeamDomain } from "./auth/access-jwt-verifier.js";
import { DEFAULT_DEVICE_SESSION_TTL_SECONDS } from "./auth/device-auth.js";

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
  /** Loopback port of the local admin API (never proxied by the tunnel). */
  readonly adminPort: number;
  /** Absolute path of the Bridge data directory (created with mode 0o700). */
  readonly dataDir: string;
  /** SQLite database file inside {@link BridgeConfig.dataDir}. */
  readonly databasePath: string;
  /** Append-only audit log file inside {@link BridgeConfig.dataDir}. */
  readonly auditLogPath: string;
  /** Byte budget for pending (undelivered) events per session fan-out. */
  readonly pendingEventsByteBudget: number;
  /**
   * Claude Code executable override (BRIDGE_CLAUDE_BIN). When unset, the
   * process factory resolves `claude` from PATH at construction and stores
   * the absolute path.
   */
  readonly claudeBin?: string | undefined;
  /**
   * Absolute path of the permission MCP adapter entry script
   * (BRIDGE_PERMISSION_ADAPTER_ENTRY). Claude Code spawns it as the
   * per-session MCP server via the `--strict-mcp-config` JSON.
   */
  readonly permissionAdapterEntry?: string | undefined;
  /**
   * Seconds a permission request may stay pending before the broker
   * auto-denies it (spec §6.4: at most five minutes).
   */
  readonly permissionTimeoutSeconds: number;
  /**
   * Cloudflare Access team domain (BRIDGE_CLOUDFLARE_TEAM_DOMAIN), e.g.
   * `myteam.cloudflareaccess.com`. Optional: local-only operation boots
   * without it. An `https://` scheme prefix is accepted and normalized away;
   * required together with {@link BridgeConfig.cloudflareAud} when the
   * Access JWT verifier is constructed (remote access, Task 24).
   */
  readonly cloudflareTeamDomain?: string | undefined;
  /**
   * Cloudflare Access application audience tag (BRIDGE_CLOUDFLARE_AUD).
   * Optional; required together with {@link BridgeConfig.cloudflareTeamDomain}
   * when the Access JWT verifier is constructed (remote access, Task 24).
   */
  readonly cloudflareAud?: string | undefined;
  /**
   * Device session token lifetime in seconds
   * (BRIDGE_DEVICE_SESSION_TTL_SECONDS; spec §10.3: fifteen minutes).
   * Used by the device-auth registry.
   */
  readonly deviceSessionTtlSeconds: number;
  /**
   * Public hostname devices use to reach the Bridge through the Cloudflare
   * Tunnel (BRIDGE_PUBLIC_HOST), e.g. `bridge.example.com`. Optional: the
   * admin CLI requires it to build the `claude-remote://pair` payload for
   * pairing QR codes; the server itself does not use it.
   */
  readonly publicHost?: string | undefined;
  /**
   * APK signing certificate SHA-256 fingerprint
   * (BRIDGE_ASSETLINKS_FINGERPRINT), e.g. `AA:BB:…` (colons optional,
   * normalized to colon-separated uppercase hex). Optional: when set the
   * server serves `/.well-known/assetlinks.json` declaring Android App Link
   * verification for the app against the public host.
   */
  readonly assetlinksFingerprint?: string | undefined;
  /**
   * Claude Code configuration directory (CLAUDE_CONFIG_DIR). The spawned
   * CLI processes inherit it via the environment, and the history layer
   * reads transcripts from `<claudeConfigDir>/projects/<encoded-project>/`.
   * Default: `~/.claude`.
   */
  readonly claudeConfigDir: string;
}

/** Loopback hosts the Bridge is allowed to bind to. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 43111;
export const DEFAULT_BRIDGE_ADMIN_PORT = 43112;

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

/**
 * Default permission wait before auto-deny (spec §6.4: at most five
 * minutes). Configurable via BRIDGE_PERMISSION_TIMEOUT_SECONDS; used by
 * the permission broker (Task 17).
 */
export const DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300;

export type EnvSource = Record<string, string | undefined>;

function readString(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse dotenv-style KEY=VALUE text (the 0600 env file written by the
 * launchd installer, Task 34). One assignment per line; `#` comments and
 * blank/malformed lines are skipped; surrounding single/double quotes on the
 * value are stripped. No interpolation.
 */
export function parseEnvFileContents(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    let value = rawValue;
    if (rawValue.length >= 2) {
      for (const quote of ['"', "'"]) {
        if (rawValue.startsWith(quote) && rawValue.endsWith(quote)) {
          value = rawValue.slice(1, -1);
        }
      }
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

/**
 * Layer BRIDGE_ENV_FILE under the given environment source (Task 34): the
 * launchd plist is mode 0644 and must carry only non-secret env inline, so
 * Cloudflare Access secrets live in a sibling 0600 file referenced via
 * BRIDGE_ENV_FILE. Real environment entries always win over file entries,
 * and empty-string env entries count as unset (same as readString).
 *
 * The file must be an absolute path, must exist, and must not be readable or
 * writable by group/others — it carries secrets.
 */
function layerEnvFile(env: EnvSource): EnvSource {
  const envFile = readString(env, "BRIDGE_ENV_FILE");
  if (envFile === undefined) return env;
  if (!isAbsolute(envFile)) {
    throw new Error(`BRIDGE_ENV_FILE must be an absolute path; got ${JSON.stringify(envFile)}.`);
  }
  let stats;
  try {
    stats = statSync(envFile);
  } catch {
    throw new Error(`BRIDGE_ENV_FILE points at a missing or unreadable file: ${envFile}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `BRIDGE_ENV_FILE must not be readable or writable by group/others (expected mode 0600 or stronger); ` +
        `got mode 0${(stats.mode & 0o777).toString(8)} for ${envFile}.`,
    );
  }
  const fromFile = parseEnvFileContents(readFileSync(envFile, "utf8"));
  const merged: Record<string, string> = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") merged[key] = value;
  }
  return merged;
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

/** Exported so the admin server reuses identical validation (loopback rule stays private to parseHost). */
export function parsePortValue(env: EnvSource, key: string, defaultPort: number): number {
  const raw = readString(env, key) ?? String(defaultPort);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${key} must be an integer between 1024 and 65535; got ${JSON.stringify(raw)}.`);
  }
  return port;
}

function parsePort(env: EnvSource): number {
  return parsePortValue(env, "BRIDGE_PORT", DEFAULT_BRIDGE_PORT);
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

function parseOptionalAbsolutePath(env: EnvSource, key: string): string | undefined {
  const value = readString(env, key);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path; got ${JSON.stringify(value)}.`);
  }
  return value;
}

function parsePermissionTimeoutSeconds(env: EnvSource): number {
  const raw = readString(env, "BRIDGE_PERMISSION_TIMEOUT_SECONDS");
  if (raw === undefined) return DEFAULT_PERMISSION_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `BRIDGE_PERMISSION_TIMEOUT_SECONDS must be a positive integer (seconds); got ${JSON.stringify(raw)}.`,
    );
  }
  return seconds;
}

function parseDeviceSessionTtlSeconds(env: EnvSource): number {
  const raw = readString(env, "BRIDGE_DEVICE_SESSION_TTL_SECONDS");
  if (raw === undefined) return DEFAULT_DEVICE_SESSION_TTL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `BRIDGE_DEVICE_SESSION_TTL_SECONDS must be a positive integer (seconds); got ${JSON.stringify(raw)}.`,
    );
  }
  return seconds;
}

function parseClaudeConfigDir(env: EnvSource): string {
  const raw = readString(env, "CLAUDE_CONFIG_DIR");
  if (raw === undefined) return join(homedir(), ".claude");
  if (!isAbsolute(raw)) {
    throw new Error(`CLAUDE_CONFIG_DIR must be an absolute path; got ${JSON.stringify(raw)}.`);
  }
  return raw;
}

/**
 * Optional Cloudflare Access team domain. When present it must form a valid
 * team domain (with or without an `https://` scheme, which is normalized
 * away). Deliberately NOT paired with BRIDGE_CLOUDFLARE_AUD at load time:
 * the verifier requires both at construction, and Task 24 fails startup when
 * remote access is enabled without a complete pair.
 */
function parseCloudflareTeamDomain(env: EnvSource): string | undefined {
  const raw = readString(env, "BRIDGE_CLOUDFLARE_TEAM_DOMAIN");
  if (raw === undefined) return undefined;
  const normalized = normalizeTeamDomain(raw);
  if (normalized === undefined) {
    throw new Error(
      `BRIDGE_CLOUDFLARE_TEAM_DOMAIN must be a Cloudflare Access team domain such as ` +
        `"myteam.cloudflareaccess.com" (optionally prefixed with "https://"); got ${JSON.stringify(raw)}.`,
    );
  }
  return normalized;
}

/**
 * Optional APK signing certificate SHA-256 fingerprint
 * (BRIDGE_ASSETLINKS_FINGERPRINT): 64 hex digits, with or without the
 * `AA:BB:…` colons, normalized to colon-separated uppercase for
 * assetlinks.json. Optional; absent disables the assetlinks route.
 */
function parseAssetlinksFingerprint(env: EnvSource): string | undefined {
  const raw = readString(env, "BRIDGE_ASSETLINKS_FINGERPRINT");
  if (raw === undefined) return undefined;
  const hex = raw.replace(/:/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `BRIDGE_ASSETLINKS_FINGERPRINT must be the APK signing certificate SHA-256 fingerprint ` +
        `(64 hex digits, colons optional); got ${JSON.stringify(raw)}.`,
    );
  }
  return (hex.match(/.{2}/g) ?? []).map((pair) => pair.toUpperCase()).join(":");
}

/**
 * Validate environment variables and produce an immutable
 * {@link BridgeConfig}. Creates {@link BRIDGE_DATA_DIR} recursively with
 * owner-only permissions after validation succeeds. When BRIDGE_ENV_FILE is
 * set, its dotenv-style contents are layered UNDER the passed environment
 * ({@link layerEnvFile}) before validation.
 */
export function loadConfig(env: EnvSource): BridgeConfig {
  const source = layerEnvFile(env);
  const host = parseHost(source);
  const port = parsePort(source);
  const adminPort = parsePortValue(source, "BRIDGE_ADMIN_PORT", DEFAULT_BRIDGE_ADMIN_PORT);
  if (adminPort === port) {
    throw new Error(`BRIDGE_ADMIN_PORT must differ from BRIDGE_PORT (both are ${port}).`);
  }
  const dataDir = parseDataDir(source);
  const pendingEventsByteBudget = parsePendingEventsByteBudget(source);
  const claudeBin = readString(source, "BRIDGE_CLAUDE_BIN");
  const permissionAdapterEntry = parseOptionalAbsolutePath(source, "BRIDGE_PERMISSION_ADAPTER_ENTRY");
  const permissionTimeoutSeconds = parsePermissionTimeoutSeconds(source);
  const cloudflareTeamDomain = parseCloudflareTeamDomain(source);
  const cloudflareAud = readString(source, "BRIDGE_CLOUDFLARE_AUD");
  const deviceSessionTtlSeconds = parseDeviceSessionTtlSeconds(source);
  const publicHost = readString(source, "BRIDGE_PUBLIC_HOST");
  const assetlinksFingerprint = parseAssetlinksFingerprint(source);
  const claudeConfigDir = parseClaudeConfigDir(source);

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return Object.freeze({
    host,
    port,
    adminPort,
    dataDir,
    databasePath: join(dataDir, "bridge.db"),
    auditLogPath: join(dataDir, "audit.jsonl"),
    pendingEventsByteBudget,
    claudeBin,
    permissionAdapterEntry,
    permissionTimeoutSeconds,
    cloudflareTeamDomain,
    cloudflareAud,
    deviceSessionTtlSeconds,
    publicHost,
    assetlinksFingerprint,
    claudeConfigDir,
  });
}

// Render the cloudflared tunnel + Cloudflare Access configuration for the
// claude-remote Bridge (implementation-plan Task 35; spec §5, §10.1, §10.2).
//
// Inputs come from the SAME 0600 env file the launchd installer writes
// (Task 34: ~/Library/LaunchAgents/dev.clauderemote.bridge.env) — the user
// appends the cloudflared/Access keys after running
// `cloudflared tunnel create`:
//
//   CF_TUNNEL_ID=<uuid from `cloudflared tunnel create`>
//   CF_TUNNEL_CREDENTIALS_FILE=/absolute/path/to/<uuid>.json
//   CF_ACCESS_SUBJECTS=owner@example.com[,second@example.com]
//   CF_ACCESS_EMAIL_IDP=<one-time PIN IdP id>        (optional)
//
// Outputs (default ~/.cloudflared, mode 0600):
//   config.yml      — cloudflared tunnel config; ONE ingress hostname →
//                     http://127.0.0.1:<BRIDGE_PORT>, final 404 catch-all.
//   access-app.json — documented Access application example with variables
//                     filled; the user applies it via the CF dashboard/API.
//
// SECURITY INVARIANTS (each has a test in render-cloudflared-config.test.ts):
//
//   1. Never a second hostname: the public host is a single HTTPS-scheme
//      DNS host; comma/space separated lists are a typed error.
//   2. Never a non-HTTPS public scheme (http://… is refused, not normalized).
//   3. Never a service token: CF_SERVICE_TOKEN / CF_ACCESS_CLIENT_ID /
//      CF_ACCESS_CLIENT_SECRET keys and bearer-style values are rejected at
//      input validation — the rendered files cannot carry them. Per-device
//      Access Managed OAuth is the only supported authentication (§10.2).
//   4. Never an empty variable: every required input must resolve non-empty;
//      the error names the variable. Leftover {{PLACEHOLDER}} tokens in the
//      rendered output are a typed error too.
//   5. Never a foreign port: the only origin is 127.0.0.1:<bridge port>.
//
// Run: npx tsx deploy/scripts/render-cloudflared-config.ts [--dry-run]

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_BRIDGE_PORT, ENV_FILENAME } from "./install-launchd.js";
import { parseEnvFile } from "./env-file.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const here = fileURLToPath(new URL(".", import.meta.url));
/** deploy/cloudflared/config.yml.template */
export const CONFIG_TEMPLATE_PATH = resolve(here, "../cloudflared", "config.yml.template");
/** deploy/cloudflared/access-app.example.json */
export const ACCESS_APP_EXAMPLE_PATH = resolve(here, "../cloudflared", "access-app.example.json");

/** Fixed catch-all terminating every cloudflared ingress list. */
const INGRESS_CATCH_ALL = "http_status:404";

// ---------------------------------------------------------------------------
// Errors and types
// ---------------------------------------------------------------------------

/** Typed renderer failure; `code` is machine-readable for tests and CI. */
export class RenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

/** Raw renderer input (CLI flags / env-file values). */
export interface TunnelConfigInput {
  /** cloudflared tunnel UUID or name (CF_TUNNEL_ID). */
  tunnelId?: string | undefined;
  /** Absolute path to the tunnel credentials JSON (CF_TUNNEL_CREDENTIALS_FILE). */
  credentialsFile?: string | undefined;
  /** Public HTTPS host (BRIDGE_PUBLIC_HOST); https:// prefix and :443 normalized away. */
  publicHost?: string | undefined;
  /** Bridge HTTP port (BRIDGE_PORT); default {@link DEFAULT_BRIDGE_PORT}. */
  port?: number | undefined;
  /** Cloudflare Access audience tag (BRIDGE_CLOUDFLARE_AUD). */
  aud?: string | undefined;
  /** Allowed Access subject emails (CF_ACCESS_SUBJECTS), comma-separated string or list. */
  subjects?: string | readonly string[] | undefined;
  /** Optional one-time-PIN email IdP id to pin `allowed_idps` (CF_ACCESS_EMAIL_IDP). */
  emailIdp?: string | undefined;
}

/** Validated, immutable renderer config. */
export interface TunnelConfig {
  readonly tunnelId: string;
  readonly credentialsFile: string;
  readonly publicHost: string;
  readonly port: number;
  readonly aud: string;
  readonly subjects: readonly string[];
  readonly emailIdp: string | undefined;
}

export interface RenderOptions {
  /** Output directory; default `<homeDir>/.cloudflared`. */
  readonly outDir?: string | undefined;
  /** Override $HOME-derived paths (tests use a tmp dir). */
  readonly homeDir?: string | undefined;
  /** Print the plan and rendered files without writing. */
  readonly dryRun?: boolean | undefined;
  /** Progress sink (default: silent; CLI passes console.log). */
  readonly log?: ((line: string) => void) | undefined;
}

export interface RenderResult {
  readonly configYmlPath: string;
  readonly accessAppPath: string;
  readonly dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Service-token rejection (invariant 3) — the renderer never accepts them
// ---------------------------------------------------------------------------

/** Keys that indicate Cloudflare service-token style credentials. */
const SERVICE_TOKEN_KEY_PATTERNS: RegExp[] = [
  /service[-_]?token/i,
  /^cf_access_client_(id|secret)$/i,
];

/** Values that look like an inlined bearer credential. */
const SERVICE_TOKEN_VALUE_PATTERN = /authorization\s*:\s*bearer/i;

/** Reject service-token style keys/values in a parsed env record. */
export function assertNoServiceTokens(record: Record<string, string>): void {
  for (const [key, value] of Object.entries(record)) {
    if (SERVICE_TOKEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new RenderError(
        "SERVICE_TOKEN_REJECTED",
        `refusing service-token style input ${JSON.stringify(key)}: the Bridge never uses Cloudflare ` +
          "service tokens; remote authentication is per-device Access Managed OAuth (spec §10.2).",
      );
    }
    if (typeof value === "string" && SERVICE_TOKEN_VALUE_PATTERN.test(value)) {
      throw new RenderError(
        "SERVICE_TOKEN_REJECTED",
        `value of ${JSON.stringify(key)} looks like a bearer credential; refusing to render it into any output.`,
      );
    }
  }
}

function assertNoServiceTokenValues(values: readonly string[]): void {
  for (const value of values) {
    if (SERVICE_TOKEN_VALUE_PATTERN.test(value)) {
      throw new RenderError(
        "SERVICE_TOKEN_REJECTED",
        "input value looks like a bearer credential; refusing to render it into any output.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Validation (invariants 1, 2, 4)
// ---------------------------------------------------------------------------

function emptyVariable(name: string): RenderError {
  return new RenderError(
    "EMPTY_VARIABLE",
    `${name} must not be empty — every template variable must resolve to a non-empty value.`,
  );
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw emptyVariable(name);
  return value.trim();
}

const TUNNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DNS_HOST_PATTERN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/**
 * Normalize the public host per spec §10.3: scheme must be https (an http://
 * or other scheme is a typed error, never silently accepted), no userinfo,
 * query, fragment, path, or port other than empty/443, and exactly ONE host —
 * a comma/space separated list is a typed error.
 */
function normalizePublicHost(raw: string): string {
  // A comma-separated list is always "a second hostname" → refuse.
  const commaParts = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (commaParts.length > 1) {
    throw new RenderError(
      "MULTIPLE_PUBLIC_HOSTS",
      `BRIDGE_PUBLIC_HOST must be exactly one hostname; refusing the second hostname in ${JSON.stringify(raw)}.`,
    );
  }
  let candidate = commaParts[0] ?? "";
  if (candidate === "") throw emptyVariable("BRIDGE_PUBLIC_HOST");

  // Whitespace: multiple dot-bearing tokens read as a second hostname;
  // anything else is simply not a valid host.
  const spaceParts = candidate.split(/\s+/).filter((part) => part !== "");
  if (spaceParts.length > 1) {
    if (spaceParts.filter((part) => part.includes(".")).length >= 2) {
      throw new RenderError(
        "MULTIPLE_PUBLIC_HOSTS",
        `BRIDGE_PUBLIC_HOST must be exactly one hostname; refusing ${JSON.stringify(raw)}.`,
      );
    }
    throw new RenderError(
      "INVALID_PUBLIC_HOST",
      `BRIDGE_PUBLIC_HOST must be a single DNS hostname; got ${JSON.stringify(raw)}.`,
    );
  }
  candidate = spaceParts[0] ?? candidate;

  // Scheme: only https:// may be present, and it is normalized away.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(candidate);
  if (scheme !== null) {
    const schemeName = scheme[1] ?? "";
    if (schemeName.toLowerCase() !== "https") {
      throw new RenderError(
        "NON_HTTPS_SCHEME",
        `BRIDGE_PUBLIC_HOST must use the https scheme; refusing ${JSON.stringify(raw)} (spec §10.3).`,
      );
    }
    candidate = candidate.slice(scheme[0].length);
  }

  // Port: only the implicit or explicit 443 is allowed; strip it.
  if (candidate.endsWith(":443")) candidate = candidate.slice(0, -":443".length);
  for (const marker of [":", "@", "/", "?", "#"]) {
    if (candidate.includes(marker)) {
      throw new RenderError(
        "INVALID_PUBLIC_HOST",
        `BRIDGE_PUBLIC_HOST must be a bare DNS host (no userinfo, path, query, fragment, or port ` +
          `other than 443); got ${JSON.stringify(raw)}.`,
      );
    }
  }

  candidate = candidate.toLowerCase().replace(/\.$/, "");
  if (!DNS_HOST_PATTERN.test(candidate)) {
    throw new RenderError(
      "INVALID_PUBLIC_HOST",
      `BRIDGE_PUBLIC_HOST must be a DNS hostname under your Cloudflare zone; got ${JSON.stringify(raw)}.`,
    );
  }
  return candidate;
}

/** Parse CF_ACCESS_SUBJECTS: comma-separated string or a list; never empty. */
function parseSubjects(raw: string | readonly string[] | undefined): readonly string[] {
  if (raw === undefined) throw emptyVariable("CF_ACCESS_SUBJECTS");
  const parts = (typeof raw === "string" ? raw.split(",") : [...raw]).map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw emptyVariable("CF_ACCESS_SUBJECTS");
  }
  for (const part of parts) {
    if (!EMAIL_PATTERN.test(part)) {
      throw new RenderError(
        "INVALID_SUBJECT",
        `CF_ACCESS_SUBJECTS entries must be plain email addresses for the email identity policy; got ${JSON.stringify(part)}.`,
      );
    }
  }
  return Object.freeze(parts);
}

/** Validate raw input into a {@link TunnelConfig}. Throws {@link RenderError}. */
export function normalizeTunnelConfig(input: TunnelConfigInput): TunnelConfig {
  // Invariant 3 applies to every accepted value, before any field parsing.
  assertNoServiceTokenValues(
    [input.tunnelId, input.credentialsFile, input.publicHost, input.aud, input.emailIdp].filter(
      (value): value is string => typeof value === "string",
    ).concat(typeof input.subjects === "string" ? [input.subjects] : []),
  );

  const tunnelId = requireNonEmpty(input.tunnelId, "CF_TUNNEL_ID");
  if (!TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new RenderError(
      "INVALID_TUNNEL_ID",
      `CF_TUNNEL_ID must be the tunnel UUID or name from \`cloudflared tunnel create\`; got ${JSON.stringify(tunnelId)}.`,
    );
  }

  const credentialsFile = requireNonEmpty(input.credentialsFile, "CF_TUNNEL_CREDENTIALS_FILE");
  if (!isAbsolute(credentialsFile)) {
    throw new RenderError(
      "INVALID_CREDENTIALS_PATH",
      `CF_TUNNEL_CREDENTIALS_FILE must be an absolute path (cloudflared resolves relative paths against the ` +
        `config file location, which is surprising); got ${JSON.stringify(credentialsFile)}.`,
    );
  }

  const publicHost = normalizePublicHost(requireNonEmpty(input.publicHost, "BRIDGE_PUBLIC_HOST"));

  const port = input.port ?? DEFAULT_BRIDGE_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RenderError(
      "INVALID_PORT",
      `BRIDGE_PORT must be an integer between 1024 and 65535; got ${JSON.stringify(input.port)}.`,
    );
  }

  const aud = requireNonEmpty(input.aud, "BRIDGE_CLOUDFLARE_AUD");

  let emailIdp: string | undefined;
  if (input.emailIdp !== undefined) {
    emailIdp = requireNonEmpty(input.emailIdp, "CF_ACCESS_EMAIL_IDP");
  }

  return Object.freeze({
    tunnelId,
    credentialsFile: resolve(credentialsFile),
    publicHost,
    port,
    aud,
    subjects: parseSubjects(input.subjects),
    emailIdp,
  });
}

// ---------------------------------------------------------------------------
// Env-file integration (Task 34's 0600 env file supplies the values)
// ---------------------------------------------------------------------------

/**
 * Assemble renderer input from the parsed Task 34 env file (plus any keys the
 * user appended). Explicit CLI-style overrides win over file values. Unknown
 * keys (e.g. BRIDGE_CLOUDFLARE_TEAM_DOMAIN) are tolerated and ignored;
 * service-token style keys are rejected outright.
 */
export function tunnelInputFromEnvFile(
  record: Record<string, string>,
  overrides: TunnelConfigInput = {},
): TunnelConfigInput {
  assertNoServiceTokens(record);
  const filePort = record["BRIDGE_PORT"];
  const subjects = overrides.subjects ?? record["CF_ACCESS_SUBJECTS"];
  const port = overrides.port ?? (filePort !== undefined ? Number(filePort) : undefined);
  return {
    tunnelId: overrides.tunnelId ?? record["CF_TUNNEL_ID"],
    credentialsFile: overrides.credentialsFile ?? record["CF_TUNNEL_CREDENTIALS_FILE"],
    publicHost: overrides.publicHost ?? record["BRIDGE_PUBLIC_HOST"],
    aud: overrides.aud ?? record["BRIDGE_CLOUDFLARE_AUD"],
    emailIdp: overrides.emailIdp ?? record["CF_ACCESS_EMAIL_IDP"],
    ...(subjects !== undefined ? { subjects } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rendering (pure) + output invariants (1, 4, 5)
// ---------------------------------------------------------------------------

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) =>
    name in values ? values[name] ?? whole : whole,
  );
}

/** Any leftover {{PLACEHOLDER}} means a variable did not resolve → typed error. */
function assertNoUnresolvedVariables(rendered: string): void {
  const leftover = [...rendered.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1] ?? "?");
  if (leftover.length > 0) {
    throw new RenderError(
      "UNRESOLVED_VARIABLE",
      `template variables did not resolve: ${[...new Set(leftover)].join(", ")}.`,
    );
  }
}

/** Drop full-line `#` comments so invariant scans only see configuration. */
function stripYamlComments(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Post-condition on the rendered cloudflared config: exactly one ingress
 * hostname (the public host), its service is the loopback Bridge port, the
 * final rule is the 404 catch-all, no origin-request tweaks, no foreign
 * loopback port, no service-token material (defense in depth — the renderer
 * already refuses such inputs, this guards the emitted bytes).
 */
function assertIngressInvariants(yaml: string, config: TunnelConfig): void {
  const stripped = stripYamlComments(yaml);

  const hostnames = [...stripped.matchAll(/^[ \t]*(?:-[ \t]+)?hostname:[ \t]*(\S+)[ \t]*$/gm)].map(
    (m) => m[1] ?? "",
  );
  if (hostnames.length !== 1 || hostnames[0] !== config.publicHost) {
    throw new RenderError(
      "INGRESS_INVARIANT_VIOLATED",
      `rendered ingress must map exactly one hostname (${config.publicHost}); found ${JSON.stringify(hostnames)}.`,
    );
  }

  const services = [...stripped.matchAll(/^[ \t]*(?:-[ \t]+)?service:[ \t]*(\S+)[ \t]*$/gm)].map(
    (m) => m[1] ?? "",
  );
  const loopback = `http://127.0.0.1:${config.port}`;
  if (services.length !== 2 || services[0] !== loopback || services[1] !== INGRESS_CATCH_ALL) {
    throw new RenderError(
      "INGRESS_INVARIANT_VIOLATED",
      `rendered ingress services must be exactly [${loopback}, ${INGRESS_CATCH_ALL}]; found ${JSON.stringify(services)}.`,
    );
  }
  if (!stripped.trimEnd().endsWith(`- service: ${INGRESS_CATCH_ALL}`)) {
    throw new RenderError(
      "INGRESS_INVARIANT_VIOLATED",
      "the http_status:404 catch-all must be the final ingress rule.",
    );
  }

  for (const match of stripped.matchAll(/127\.0\.0\.1:(\d+)/g)) {
    if (Number(match[1]) !== config.port) {
      throw new RenderError(
        "INGRESS_INVARIANT_VIOLATED",
        `cloudflared must never forward a port other than the Bridge HTTP port ${config.port}; found 127.0.0.1:${match[1]}.`,
      );
    }
  }

  if (/originRequest/.test(stripped) || /noTLSVerify/i.test(stripped)) {
    throw new RenderError(
      "INGRESS_INVARIANT_VIOLATED",
      "origin-request overrides (notably TLS-verification bypasses) are forbidden: the origin is plain HTTP on loopback.",
    );
  }
  if (/service[-_]?token/i.test(stripped) || SERVICE_TOKEN_VALUE_PATTERN.test(stripped)) {
    throw new RenderError(
      "SERVICE_TOKEN_REJECTED",
      "rendered config.yml must not contain service-token material.",
    );
  }
}

/** Render config.yml from deploy/cloudflared/config.yml.template. */
export function renderConfigYml(config: TunnelConfig): string {
  const rendered = substitute(readFileSync(CONFIG_TEMPLATE_PATH, "utf8"), {
    CF_TUNNEL_ID: config.tunnelId,
    CF_TUNNEL_CREDENTIALS_FILE: config.credentialsFile,
    BRIDGE_PUBLIC_HOST: config.publicHost,
    BRIDGE_PORT: String(config.port),
  });
  assertNoUnresolvedVariables(rendered);
  assertIngressInvariants(rendered, config);
  return rendered;
}

/** The email `include` entries for the Access policy — user subjects only. */
function emailIncludes(subjects: readonly string[]): string {
  return JSON.stringify(subjects.map((email) => ({ email: { email } })));
}

interface AccessApp {
  name?: unknown;
  domain?: unknown;
  type?: unknown;
  aud?: unknown;
  allowed_idps?: unknown;
  app_launcher_visible?: unknown;
  bypass?: unknown;
  policies?: unknown;
}

/**
 * Post-condition on the parsed Access application: one self_hosted app on the
 * same hostname, the assetlinks exact-path bypass only, and an email identity
 * policy allowing exactly the user-supplied subjects — nothing else.
 */
function assertAccessAppInvariants(app: AccessApp, config: TunnelConfig): void {
  if (app.domain !== config.publicHost) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      `access app domain must be the public host ${config.publicHost}; got ${JSON.stringify(app.domain)}.`,
    );
  }
  if (app.type !== "self_hosted" || app.app_launcher_visible !== false) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      "access app must be self_hosted and not visible in the app launcher.",
    );
  }
  if (app.aud !== config.aud) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      `access app aud must match BRIDGE_CLOUDFLARE_AUD; got ${JSON.stringify(app.aud)}.`,
    );
  }
  const expectedBypass = [{ type: "exact_path", value: "/.well-known/assetlinks.json" }];
  if (JSON.stringify(app.bypass) !== JSON.stringify(expectedBypass)) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      "the only bypass must be the exact path /.well-known/assetlinks.json (Android App Link verification).",
    );
  }
  const expectedInclude = config.subjects.map((email) => ({ email: { email } }));
  const policies = Array.isArray(app.policies) ? app.policies : [];
  if (
    policies.length !== 1 ||
    JSON.stringify(policies[0]) !==
      JSON.stringify({ name: "owner only", decision: "allow", include: expectedInclude })
  ) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      "the single policy must be an allow listing exactly the user-supplied email subjects.",
    );
  }
  const serialized = JSON.stringify(app);
  if (/service[-_]?token/i.test(serialized) || SERVICE_TOKEN_VALUE_PATTERN.test(serialized)) {
    throw new RenderError(
      "SERVICE_TOKEN_REJECTED",
      "rendered access-app.json must not contain service-token material.",
    );
  }
}

/**
 * Render access-app.json from deploy/cloudflared/access-app.example.json.
 * The example is strict JSON with {{PLACEHOLDER}} variables; after
 * substitution the text is parsed, sanitized (an unset optional email IdP
 * drops `allowed_idps`), invariant-checked, and re-serialized.
 */
export function renderAccessApp(config: TunnelConfig): string {
  const substituted = substitute(readFileSync(ACCESS_APP_EXAMPLE_PATH, "utf8"), {
    BRIDGE_PUBLIC_HOST: config.publicHost,
    BRIDGE_CLOUDFLARE_AUD: config.aud,
    CF_ACCESS_EMAIL_IDP: config.emailIdp ?? "",
    CF_ACCESS_INCLUDES: emailIncludes(config.subjects),
  });
  let app: AccessApp;
  try {
    app = JSON.parse(substituted) as AccessApp;
  } catch (error) {
    throw new RenderError(
      "ACCESS_APP_INVARIANT_VIOLATED",
      `rendered access app is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // An unset optional IdP renders as "" — drop it rather than emit [""].
  if (Array.isArray(app.allowed_idps)) {
    const idps = app.allowed_idps.filter((idp): idp is string => typeof idp === "string" && idp !== "");
    if (idps.length === 0) delete app.allowed_idps;
    else app.allowed_idps = idps;
  }
  assertAccessAppInvariants(app, config);
  return `${JSON.stringify(app, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Validate, render, and write config.yml + access-app.json. Nothing is
 * written before {@link normalizeTunnelConfig} and both renderers' own
 * invariants pass; files land with mode 0600 (the tunnel UUID, aud tag, and
 * owner identity are not for other local users).
 */
export function renderTunnelFiles(input: TunnelConfigInput, options: RenderOptions = {}): RenderResult {
  const config = normalizeTunnelConfig(input);
  const outDir = options.outDir ?? join(options.homeDir ?? homedir(), ".cloudflared");
  const configYmlPath = join(outDir, "config.yml");
  const accessAppPath = join(outDir, "access-app.json");
  const log = options.log ?? (() => {});

  const yaml = renderConfigYml(config);
  const appJson = renderAccessApp(config);

  if (options.dryRun === true) {
    log(`[dry-run] config.yml (0600):    ${configYmlPath}`);
    log(`[dry-run] access-app.json (0600): ${accessAppPath}`);
    log(`[dry-run] rendered config.yml:\n${yaml}`);
    log(`[dry-run] rendered access-app.json:\n${appJson}`);
    return { configYmlPath, accessAppPath, dryRun: true };
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(configYmlPath, yaml, { mode: 0o600 });
  chmodSync(configYmlPath, 0o600);
  writeFileSync(accessAppPath, appJson, { mode: 0o600 });
  chmodSync(accessAppPath, 0o600);

  if (config.emailIdp === undefined) {
    log(
      "NOTE: CF_ACCESS_EMAIL_IDP is not set — the rendered app allows every identity provider on the " +
        "team. Set it to your One-time PIN email IdP id to restrict login methods.",
    );
  }
  log(`wrote ${configYmlPath}`);
  log(`wrote ${accessAppPath}`);
  log("apply the Access application via the Cloudflare dashboard or API, then run:");
  log(`  cloudflared tunnel run --config ${configYmlPath}`);
  return { configYmlPath, accessAppPath, dryRun: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: tsx deploy/scripts/render-cloudflared-config.ts [options]

Renders the cloudflared tunnel config.yml and the Cloudflare Access
access-app.json for the claude-remote Bridge. Reads the same 0600 env file
the launchd installer writes (~/Library/LaunchAgents/${ENV_FILENAME}) —
append CF_TUNNEL_ID / CF_TUNNEL_CREDENTIALS_FILE / CF_ACCESS_SUBJECTS after
running \`cloudflared tunnel create\`. Refuses a second hostname, a
non-HTTPS public scheme, service-token style inputs, and any variable that
resolves to empty. The only origin ever forwarded is
http://127.0.0.1:<BRIDGE_PORT>.

options:
  --config <path>          env-style file (default ~/Library/LaunchAgents/${ENV_FILENAME})
  --tunnel-id <id>         CF_TUNNEL_ID (tunnel UUID or name)
  --credentials-file <p>   CF_TUNNEL_CREDENTIALS_FILE (absolute path)
  --public-host <host>     BRIDGE_PUBLIC_HOST (https://host, single hostname)
  --port <n>               BRIDGE_PORT, default ${DEFAULT_BRIDGE_PORT}
  --aud <tag>              BRIDGE_CLOUDFLARE_AUD
  --subjects <a,b>         CF_ACCESS_SUBJECTS, comma-separated email addresses
  --email-idp <id>         CF_ACCESS_EMAIL_IDP, optional one-time PIN IdP id
  --out-dir <path>         output directory (default ~/.cloudflared)
  --home-dir <path>        override $HOME (testing)
  --dry-run                print the rendered files, write nothing
  -h, --help               show this help
`;

interface CliArgs {
  config?: string;
  tunnelId?: string;
  credentialsFile?: string;
  publicHost?: string;
  port?: number;
  aud?: string;
  subjects?: string;
  emailIdp?: string;
  outDir?: string;
  homeDir?: string;
  dryRun?: boolean;
  help?: boolean;
}

/** Parse `--key value` / boolean flags; unknown input is a typed usage error. */
export function parseArgs(argv: string[]): CliArgs {
  const valueFlags = new Set([
    "--config",
    "--tunnel-id",
    "--credentials-file",
    "--public-host",
    "--port",
    "--aud",
    "--subjects",
    "--email-idp",
    "--out-dir",
    "--home-dir",
  ]);
  const boolFlags = new Set(["--dry-run", "-h", "--help"]);
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (boolFlags.has(arg)) {
      if (arg === "-h" || arg === "--help") args.help = true;
      else args.dryRun = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RenderError("usage", `${arg} requires a value.`);
      }
      i += 1;
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (key === "config") args.config = value;
      else if (key === "tunnelId") args.tunnelId = value;
      else if (key === "credentialsFile") args.credentialsFile = value;
      else if (key === "publicHost") args.publicHost = value;
      else if (key === "port") args.port = Number(value);
      else if (key === "aud") args.aud = value;
      else if (key === "subjects") args.subjects = value;
      else if (key === "emailIdp") args.emailIdp = value;
      else if (key === "outDir") args.outDir = value;
      else if (key === "homeDir") args.homeDir = value;
      continue;
    }
    throw new RenderError("usage", `unknown argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
  }
  return args;
}

/** CLI entry: env file → flags → normalize → render. Returns exit code. */
export async function cliMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const home = args.homeDir ?? homedir();
  const configPath = args.config ?? join(home, "Library", "LaunchAgents", ENV_FILENAME);
  let record: Record<string, string> = {};
  if (existsSync(configPath)) {
    record = parseEnvFile(readFileSync(configPath, "utf8"));
  } else {
    console.log(`note: env file not found at ${configPath}; relying on flags only.`);
  }

  const input = tunnelInputFromEnvFile(record, {
    ...(args.tunnelId !== undefined ? { tunnelId: args.tunnelId } : {}),
    ...(args.credentialsFile !== undefined ? { credentialsFile: args.credentialsFile } : {}),
    ...(args.publicHost !== undefined ? { publicHost: args.publicHost } : {}),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.aud !== undefined ? { aud: args.aud } : {}),
    ...(args.subjects !== undefined ? { subjects: args.subjects } : {}),
    ...(args.emailIdp !== undefined ? { emailIdp: args.emailIdp } : {}),
  });

  renderTunnelFiles(input, {
    homeDir: home,
    ...(args.outDir !== undefined ? { outDir: args.outDir } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
    log: (line) => console.log(line),
  });
  return 0;
}

// Execute only when run directly (tsx deploy/scripts/render-cloudflared-config.ts);
// imports from tests must not trigger the CLI.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  cliMain(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof RenderError ? error.code : "unexpected_error";
    console.error(`error (${code}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

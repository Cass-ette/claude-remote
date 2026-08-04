# Claude Remote Android Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Android client that securely controls Bridge-owned Claude Code sessions running on the user's Mac through Cloudflare Access and Tunnel.

**Architecture:** A loopback-only TypeScript/Node Bridge owns Claude Code stream-json subprocesses, persists command/event state in SQLite, and exposes a versioned HTTP/WebSocket protocol. A Kotlin/Compose Android client authenticates through Cloudflare Managed OAuth plus a Keystore device key, stores its rendered projection in Room, and recovers through durable event replay and two-phase snapshots. Three independent Phase 0 probes unlock only the production capabilities whose external contracts they verify.

**Tech Stack:** Node.js 22, TypeScript, Fastify, WebSocket, SQLite/better-sqlite3, Vitest, MCP TypeScript SDK; Kotlin 2.0, Jetpack Compose, Room, OkHttp, AppAuth-Android, Android Keystore; Cloudflare Access and Tunnel; macOS launchd.

---

## Scope and execution rules

- Execute tasks in order when they depend on each other. A failed Phase 0 gate blocks only the capabilities in the dependency matrix below.
- Treat `docs/superpowers/specs/2026-08-02-claude-remote-android-design.md` as the authoritative behavior contract.
- Keep the Bridge bound to `127.0.0.1`; never add a generic shell, arbitrary file-read, or arbitrary process endpoint.
- Use TDD for deterministic code. Real-service evidence supplements tests; it does not replace unit tests.
- Use one focused commit after each task. Never amend a previous task's commit.
- Do not add uploads, notifications, tablet layouts, model selection, permanent permission rules, multi-device support, DPoP, or filesystem sandboxing.

## Phase 0 dependency matrix

| Gate | Passing unlocks | Failure does not block |
|---|---|---|
| Claude Code | stream-json adapter, Session Supervisor, Permission Broker/MCP adapter, UUID retry | database, pure protocol validation, Access/device auth, Android UI shells |
| Transcript | import, history snapshots, command crash reconciliation | new-session control, auth, live event transport |
| Cloudflare | production Access verification, Android OAuth, remote HTTP/WebSocket | loopback Bridge core, local fake transport tests, Android offline UI/data |

Each gate emits the same machine-readable result:

```ts
type GateResult = {
  name: "claude" | "transcript" | "cloudflare";
  status: "passed" | "failed" | "not_run";
  startedAt: string;
  finishedAt: string;
  checks: Array<{ name: string; passed: boolean; details?: string }>;
  evidence: Record<string, string | number | boolean>;
};
```

Thrown processes, timeouts, missing evidence, or malformed JSON are never treated as passes.

## Planned file map

### Repository and shared contracts

- `package.json` — root npm workspaces and aggregate verification scripts.
- `package-lock.json` — locked Node dependency graph.
- `tsconfig.base.json` — shared strict NodeNext compiler options.
- `tsconfig.json` — root gate-runner project.
- `.gitignore` — Node, Android, probe output, secrets, databases, and local deployment state.
- `contracts/v1/command.schema.json` — command envelope and command-specific payload schemas.
- `contracts/v1/response.schema.json` — command response schemas.
- `contracts/v1/event.schema.json` — durable server event schemas.
- `contracts/v1/auth-signing-fixture.json` — fixed cross-language P-256 fixture.

### Phase 0 probes

- `probes/gate-result.schema.json` — shared Ajv-validated evidence schema.
- `probes/run-phase0.ts` — result validator and capability-unlock aggregator.
- `probes/run-phase0.test.ts` — malformed/missing/failed evidence tests.
- `probes/claude-code/package.json`, `tsconfig.json` — Claude probe workspace.
- `probes/claude-code/src/stream-json-client.ts` — candidate-envelope NDJSON driver.
- `probes/claude-code/src/permission-probe-server.ts` — randomized harmless target and permission MCP tools.
- `probes/claude-code/src/transcript-inspector.ts` — transcript discovery, stabilization, and UUID counting.
- `probes/claude-code/test/stream-json-client.test.ts` — fake-process framing tests.
- `probes/claude-code/test/compatibility.test.ts` — opt-in real CLI assertions.
- `probes/claude-code/run-real-gate.ts` — process-level timeout/error wrapper and evidence writer.
- `probes/transcript/package.json`, `tsconfig.json` — transcript probe workspace.
- `probes/transcript/src/types.ts`, `adapter.ts` — candidate history adapter.
- `probes/transcript/test/fixtures/` — secret-scanned redacted fixtures for every evidence state.
- `probes/transcript/test/adapter.test.ts` — offsets, partial tails, and turn classification.
- `probes/transcript/run-real-gate.ts` — manifest validation, process timeout, and evidence writer.
- `probes/cloudflare/origin/package.json`, `tsconfig.json` — temporary Access origin workspace.
- `probes/cloudflare/origin/src/access-verifier.ts` — issuer/audience/subject/expiry verification.
- `probes/cloudflare/origin/src/server.ts` — HTTP/WebSocket evidence capture and public App Link statement.
- `probes/cloudflare/origin/test/server.test.ts` — local origin/auth tests.
- `probes/cloudflare/android-probe/gradlew`, `gradlew.bat`, `gradle/wrapper/` — checked-in Gradle wrapper.
- `probes/cloudflare/android-probe/app/src/main/` — minimal AppAuth/OkHttp probe app.
- `probes/cloudflare/android-probe/app/src/test/` — JVM PKCE/state/config tests.
- `probes/cloudflare/android-probe/app/src/androidTest/` — real-device HTTP/WebSocket/refresh evidence test.
- `probes/cloudflare/run-real-gate.ts` — adb/origin evidence collector.

### Mac Bridge

- `bridge/package.json`, `bridge/tsconfig.json`, `bridge/vitest.config.ts` — Bridge build/test configuration.
- `bridge/src/main.ts`, `config.ts` — composition root and validated local configuration.
- `bridge/src/server/http-server.ts`, `websocket-server.ts` — loopback HTTP/WebSocket boundary.
- `bridge/src/protocol/v1/types.ts`, `validator.ts` — protocol models and validation.
- `bridge/src/db/database.ts`, `db/migrations/001_initial.sql` — SQLite and initial schema.
- `bridge/src/commands/command-ledger.ts` — idempotent commands and transitions.
- `bridge/src/events/event-journal.ts` — durable event allocation, replay, ACK, and retention.
- `bridge/src/projects/project-registry.ts` — local project authorization and identity checks.
- `bridge/src/sessions/session-state-machine.ts`, `session-supervisor.ts` — session lifecycle and process ownership.
- `bridge/src/claude/stream-json-adapter.ts`, `process-lease-wrapper.ts` — Claude transport and process lease.
- `bridge/src/permissions/permission-broker.ts`, `socket-protocol.ts` — permission state and Unix socket.
- `bridge/src/permission-adapter/main.ts` — standalone stdio MCP adapter.
- `bridge/src/history/claude-2.1.133-adapter.ts`, `session-importer.ts` — history/import.
- `bridge/src/snapshots/snapshot-service.ts` — prepared/page/commit checkpoint protocol.
- `bridge/src/auth/access-jwt-verifier.ts`, `signing-bytes.ts`, `device-auth.ts` — two-layer auth.
- `bridge/src/audit/audit-log.ts`, `admin/cli.ts` — redacted audit and local administration.
- `bridge/test/` — mirrored unit/integration tests.

### Android app

- `android/gradlew`, `android/gradlew.bat`, `android/gradle/wrapper/` — checked-in Gradle wrapper.
- `android/settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml` — build configuration.
- `android/app/build.gradle.kts`, `src/main/AndroidManifest.xml` — API 28 Compose app.
- `android/app/src/main/java/dev/clauderemote/android/protocol/v1/ProtocolModels.kt` — protocol DTOs.
- `android/app/src/main/java/dev/clauderemote/android/data/local/` — Room database, entities, and DAOs.
- `android/app/src/main/java/dev/clauderemote/android/security/DeviceKeyManager.kt` — P-256 Keystore.
- `android/app/src/main/java/dev/clauderemote/android/auth/` — OAuth and device session lifecycle.
- `android/app/src/main/java/dev/clauderemote/android/network/` — HTTP/WebSocket and reconnect.
- `android/app/src/main/java/dev/clauderemote/android/data/SessionRepository.kt` — application API.
- `android/app/src/main/java/dev/clauderemote/android/sync/` — event reducer and snapshot coordinator.
- `android/app/src/main/java/dev/clauderemote/android/ui/` — connection, sessions, conversation, permission, import.
- `android/app/src/test/`, `android/app/src/androidTest/` — JVM/device tests.

### Deployment and end-to-end

- `deploy/launchd/dev.clauderemote.bridge.plist.template` — launchd template without secrets.
- `deploy/cloudflared/config.yml.template` — Tunnel ingress template.
- `deploy/scripts/install-launchd.ts`, `preflight.ts` — local install and self-check.
- `e2e/src/real-environment.test.ts` — opt-in real-device environment checks.
- `.github/workflows/ci.yml` — deterministic Node/Android checks without secrets.

## Chunk 1: Phase 0 compatibility gates

### Task 1: Bootstrap workspaces and the result contract

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `probes/gate-result.schema.json`
- Create: `probes/run-phase0.ts`
- Test: `probes/run-phase0.test.ts`

- [ ] **Step 1: Write the failing result-aggregation tests**

```ts
import { expect, it } from "vitest";
import { summarizeGates } from "./run-phase0.js";

it("unlocks only capabilities backed by passed gates", () => {
  const summary = summarizeGates([
    { name: "claude", status: "passed", checks: [], evidence: {}, startedAt: "x", finishedAt: "y" },
    { name: "transcript", status: "failed", checks: [], evidence: {}, startedAt: "x", finishedAt: "y" },
    { name: "cloudflare", status: "not_run", checks: [], evidence: {}, startedAt: "x", finishedAt: "y" }
  ]);
  expect(summary.unlocked).toContain("session-supervisor");
  expect(summary.blocked).toContain("history-snapshot");
  expect(summary.blocked).toContain("remote-transport");
});
```

Also test malformed JSON, missing gate results, and a check with `passed: false` under a nominal `status: "passed"`. Each individual gate script—not this evidence aggregator—is responsible for converting its subprocess timeout, nonzero exit, or missing runtime prerequisite into validated `failed` or `not_run` evidence.

- [ ] **Step 2: Create exact root configuration**

`package.json`:

```json
{
  "name": "claude-remote",
  "private": true,
  "type": "module",
  "workspaces": [],
  "scripts": {
    "test:root": "vitest run probes/run-phase0.test.ts",
    "test:workspaces": "npm run test --workspaces --if-present",
    "test": "npm run test:root && npm run test:workspaces",
    "typecheck:root": "tsc -p tsconfig.json --noEmit",
    "typecheck:workspaces": "npm run typecheck --workspaces --if-present",
    "typecheck": "npm run typecheck:root && npm run typecheck:workspaces",
    "phase0": "tsx probes/run-phase0.ts"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "ajv": "^8.17.1",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.json` extends the base config and includes only `probes/run-phase0.ts` and `probes/run-phase0.test.ts`. Each workspace receives its own config in its task.

- [ ] **Step 3: Install and verify the expected failure**

Run: `npm install && npm run test:root`
Expected: FAIL because `summarizeGates` is missing.

- [ ] **Step 4: Implement schema validation and capability mapping**

Use Ajv to validate one `GateResult` per gate. `summarizeGates` must derive the dependency matrix, not a global boolean. The CLI accepts explicit evidence paths:

```text
--claude build/phase0/claude.json
--transcript build/phase0/transcript.json
--cloudflare build/phase0/cloudflare.json
```

Missing paths produce `not_run`; malformed evidence files produce `failed`. The aggregator never launches gate processes. Write only `build/phase0/summary.json`, which is ignored by Git.

- [ ] **Step 5: Run focused verification**

Run: `npm run test:root && npm run typecheck:root`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json tsconfig.json .gitignore probes/gate-result.schema.json probes/run-phase0.ts probes/run-phase0.test.ts
git commit -m "build: bootstrap compatibility gate runner"
```

### Task 2: Probe Claude Code without assuming the raw contract

**Files:**
- Create: `probes/claude-code/package.json`
- Create: `probes/claude-code/tsconfig.json`
- Create: `probes/claude-code/src/stream-json-client.ts`
- Create: `probes/claude-code/src/permission-probe-server.ts`
- Create: `probes/claude-code/src/transcript-inspector.ts`
- Test: `probes/claude-code/test/stream-json-client.test.ts`
- Test: `probes/claude-code/test/compatibility.test.ts`
- Create: `probes/claude-code/run-real-gate.ts`

- [ ] **Step 1: Create the workspace configuration**

Use package name `@claude-remote/probe-claude-code` with scripts `test: vitest run` and `typecheck: tsc -p tsconfig.json --noEmit`. Add `@modelcontextprotocol/sdk` and `zod`; extend `../../tsconfig.base.json` and include `src/**/*.ts` plus `test/**/*.ts`. Add `probes/claude-code` to the root `workspaces` array, then run `npm install` before any workspace test so the lockfile and workspace links are current.

- [ ] **Step 2: Write fake-process tests for framing and lifecycle**

The candidate 2.1.133 envelope under test is:

```ts
const candidate = {
  type: "user",
  uuid: requestId,
  session_id: sessionId,
  message: { role: "user", content: [{ type: "text", text: prompt }] },
  parent_tool_use_id: null
};
```

Tests verify one JSON object per newline, partial stdout buffering, `system/init`, replayed UUID, multiple turns while stdin remains open, and clean termination after stdin closes. These tests verify the driver only; the real gate decides whether the candidate envelope is supported.

- [ ] **Step 3: Run the driver test and confirm failure**

Run: `npm test -w @claude-remote/probe-claude-code -- stream-json-client.test.ts`
Expected: FAIL because `ClaudeStreamClient` is missing.

- [ ] **Step 4: Implement the candidate driver and exact spawn modes**

Create:

```ts
interface ClaudeStreamClient {
  startCreate(sessionId: string, cwd: string, mcpConfig: string, permissionTool: string): Promise<void>;
  startResume(sessionId: string, cwd: string, mcpConfig: string, permissionTool: string): Promise<void>;
  sendCandidateUser(uuid: string, sessionId: string, text: string): Promise<void>;
  events(): AsyncIterable<unknown>;
  closeInput(): Promise<void>;
}
```

Create args: `-p --session-id <id> --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode default --strict-mcp-config --mcp-config <absolute> --permission-prompt-tool <name>`.

Resume args replace `--session-id <id>` with `--resume <id>`; never combine them. Keep stdin open after each `result` until the caller closes it.

- [ ] **Step 5: Implement a reliable harmless permission probe**

Run two independent stdio MCP processes in the generated config: a target server with a random tool name such as `echo_probe_<128-bit-hex>`, and a permission server containing only the permission-prompt tool. Instruct Claude to call the exact side-effect-free target with a nonce. Record ordered events from both processes. The gate passes only when:

- permission tool is observed before target execution;
- allow executes target exactly once;
- deny and five-second permission timeout execute target zero times and produce a closed failure;
- terminating only the permission server while leaving the target server healthy still prevents target execution and fails closed;
- if a local wildcard rule bypasses the randomized target prompt, return `not_run` with `permission_prompt_bypassed` rather than claiming compatibility.

- [ ] **Step 6: Implement transcript discovery and stabilization**

After `system/init`, recursively search `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects` for exactly one `<sessionId>.jsonl`. Wait until the file ends in `\n` and its size is unchanged for three 200 ms observations. Count complete JSONL user records whose UUID equals the request UUID before and after resume/retry.

Real prerequisites are explicit: installed/authenticated `claude` 2.1.133, network/API access, writable temporary project, readable transcript directory, and user acceptance of the small model cost. Never print auth environment variables or transcript content.

- [ ] **Step 7: Write and run the opt-in real gate wrapper**

The compatibility test asserts observed—not assumed—support for candidate input, matching init ID, exact replay UUID, two live turns, clean stdin close, resume, duplicate-UUID count remaining one, permission allow/deny/timeout/adapter-exit behavior, and a terminal result. It writes check details to a temporary JSON file, not the final evidence path.

`run-real-gate.ts` validates prerequisites, spawns the focused Vitest process with a ten-minute deadline, kills the exact child process group on timeout, and converts success, assertion failure, nonzero exit, signal, malformed check output, or missing prerequisites into a validated `GateResult` at `build/phase0/claude.json`.

Run: `npm test -w @claude-remote/probe-claude-code && npm run typecheck -w @claude-remote/probe-claude-code`
Expected: deterministic tests PASS.

Run: `RUN_REAL_CLAUDE=1 npx tsx probes/claude-code/run-real-gate.ts`
Expected: real gate PASS; otherwise dependent production capabilities remain blocked.

- [ ] **Step 8: Commit**

```bash
git add probes/claude-code package.json package-lock.json
git commit -m "test: gate Claude Code bridge compatibility"
```

### Task 3: Probe every transcript classification read-only

**Files:**
- Create: `probes/transcript/package.json`
- Create: `probes/transcript/tsconfig.json`
- Create: `probes/transcript/src/types.ts`
- Create: `probes/transcript/src/adapter.ts`
- Create: `probes/transcript/test/fixtures/complete.jsonl`
- Create: `probes/transcript/test/fixtures/failed.jsonl`
- Create: `probes/transcript/test/fixtures/interrupted.jsonl`
- Create: `probes/transcript/test/fixtures/partial-tail.jsonl`
- Create: `probes/transcript/test/fixtures/incompatible.jsonl`
- Test: `probes/transcript/test/adapter.test.ts`
- Test: `probes/transcript/test/fixture-secret-scan.test.ts`
- Create: `probes/transcript/run-real-gate.ts`

- [ ] **Step 1: Create the workspace and safe fixtures**

Use package name `@claude-remote/probe-transcript`, scripts `test` and `typecheck`, and a config extending `../../tsconfig.base.json`. Add `probes/transcript` to the root `workspaces` array and run `npm install` before its first test.

Create fixtures from copies, never originals. Replace sensitive strings, recompute expected UTF-8 byte offsets from the redacted bytes, and do not claim original byte-layout preservation. Add a secret scan for API-key/token patterns, home-directory paths, emails, and the original fixture strings.

- [ ] **Step 2: Write failing tests for the full evidence union**

```ts
type TurnEvidence =
  | { kind: "complete"; outcome: "completed" | "failed" }
  | { kind: "interrupted" }
  | { kind: "absent" }
  | { kind: "incompatible"; reason: string };
```

Assert user/assistant/tool normalization, known offsets computed with `Buffer.byteLength`, completed, failed, interrupted, absent, ignored partial tail, malformed complete-line incompatibility, and immutable byte-limit reads.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -w @claude-remote/probe-transcript`
Expected: FAIL because the adapter is missing.

- [ ] **Step 4: Implement the minimal versioned adapter**

Expose only `readMetadata`, `readSnapshot(path, byteLimit)`, and `findTurnEvidence(path, userUuid)`. Read through the last newline at or before `byteLimit`; never write or repair transcripts.

- [ ] **Step 5: Add the opt-in read-only real-copy gate wrapper**

Require `REAL_TRANSCRIPT_MANIFEST=/absolute/path/to/manifest.json`. The manifest is an array of copied transcript paths plus expected aggregate coverage labels; no single ordinary session must contain every outcome. The focused test hashes every copy before and after and emits temporary check output only if the set collectively covers user, assistant, tool, completed, failed, and interrupted records, normalization succeeds, and every hash is unchanged.

`run-real-gate.ts` validates the manifest and every path, spawns the focused test with a two-minute deadline, terminates it on timeout, and converts success, nonzero exit, signal, malformed output, timeout, or missing prerequisite into `build/phase0/transcript.json`.

Run: `npm test -w @claude-remote/probe-transcript && npm run typecheck -w @claude-remote/probe-transcript`
Expected: PASS.

Run: `REAL_TRANSCRIPT_MANIFEST=/absolute/manifest.json npx tsx probes/transcript/run-real-gate.ts`
Expected: PASS with aggregate coverage and unchanged SHA-256 for every input; failure blocks import/history/snapshot/reconciliation only.

- [ ] **Step 6: Commit**

```bash
git add probes/transcript package.json package-lock.json
git commit -m "test: gate Claude transcript compatibility"
```

### Task 4: Build a machine-verifiable Cloudflare mobile gate

**Files:**
- Create: `probes/cloudflare/origin/package.json`
- Create: `probes/cloudflare/origin/tsconfig.json`
- Create: `probes/cloudflare/origin/src/access-verifier.ts`
- Create: `probes/cloudflare/origin/src/server.ts`
- Test: `probes/cloudflare/origin/test/server.test.ts`
- Create: `probes/cloudflare/android-probe/` Gradle wrapper/build/app files
- Test: `probes/cloudflare/android-probe/app/src/test/java/dev/clauderemote/probe/OAuthConfigTest.kt`
- Test: `probes/cloudflare/android-probe/app/src/androidTest/java/dev/clauderemote/probe/AccessFlowInstrumentedTest.kt`
- Create: `probes/cloudflare/run-real-gate.ts`

- [ ] **Step 1: Create exact origin workspace configuration**

Use package name `@claude-remote/probe-cloudflare-origin`, scripts `test`, `typecheck`, and `start`; dependencies `fastify`, `@fastify/websocket`, `jose`, and `zod`; extend `../../../tsconfig.base.json`. Add `probes/cloudflare/origin` to the root `workspaces` array and run `npm install` before its first test.

- [ ] **Step 2: Write failing origin and Access-verification tests**

Test loopback binding, redaction, JWKS signature verification, exact issuer/audience/subject/expiry rejection, HTTP assertion capture, WebSocket Upgrade assertion capture, and evidence-file atomic writes. The origin evidence records verified claims metadata but never the assertion/token value.

- [ ] **Step 3: Implement and verify the origin**

The origin serves `/probe/http`, `/probe/ws`, `/probe/evidence`, and `/.well-known/assetlinks.json`. The App Link statement is the only path configured with an Access bypass policy; all probe API paths remain protected.

Run: `npm test -w @claude-remote/probe-cloudflare-origin && npm run typecheck -w @claude-remote/probe-cloudflare-origin`
Expected: PASS.

- [ ] **Step 4: Bootstrap the Android probe and wrapper**

Prerequisite: Android Studio or an installed `gradle` command once. First create minimal `settings.gradle.kts` with `pluginManagement`/`dependencyResolutionManagement` and a root `build.gradle.kts` declaring the Android/Kotlin plugins without applying them. Then run:

```bash
gradle -p probes/cloudflare/android-probe wrapper --gradle-version 8.9
```

Commit `gradlew`, `gradlew.bat`, and `gradle/wrapper/*`. Add the app module and configure application ID `dev.clauderemote.probe`, minSdk 28, Java 17, AppAuth-Android, OkHttp, AndroidX Browser, and a verified HTTPS App Link.

- [ ] **Step 5: Write JVM and instrumented tests before implementation**

JVM tests cover discovery URI, redirect URI, PKCE S256, `state`, required environment values, and prohibition of service-token/cookie fallback. The instrumented test performs OAuth, bearer HTTP, bearer WebSocket, captures assertion-validated server evidence, waits through the configured real expiry, proves the expired old token is rejected for both HTTP and WebSocket, refreshes, reconnects, and uses `java.net.Socket.connect(InetSocketAddress(MAC_LAN_IP, originPort), 3000)` to require connection refusal/timeout to the Mac LAN address. It then writes a `ready-for-tunnel-stop` barrier file while keeping the refreshed bearer and instrumentation process alive. After the runner stops Tunnel and sends `dev.clauderemote.probe.ACTION_TUNNEL_STOPPED`, Android retries HTTP and WebSocket with that refreshed bearer, records the edge response/no-upgrade result, and only then writes final `cloudflare-gate.json`.

Run: `./probes/cloudflare/android-probe/gradlew -p probes/cloudflare/android-probe testDebugUnitTest`
Expected: FAIL until the probe flow is implemented.

- [ ] **Step 6: Implement the minimal AppAuth/OkHttp flow**

Require runtime inputs for base URL, OAuth resource, redirect URI, and expected Access subject. Use only Authorization Code + PKCE and `Authorization: Bearer` on HTTP and WebSocket Upgrade. Never inspect or copy `CF_Authorization` cookies.

- [ ] **Step 7: Define real environment inputs and evidence collection**

Required environment:

```text
CF_PROBE_BASE_URL
CF_ACCESS_TEAM_DOMAIN
CF_ACCESS_AUD
CF_EXPECTED_SUBJECT
CLOUDFLARED_CONFIG
MAC_LAN_IP
ANDROID_SERIAL
APP_LINK_SHA256_FINGERPRINT
CF_LOGIN_TIMEOUT_MS
CF_TOKEN_EXPIRY_TIMEOUT_MS
CF_INSTRUMENTATION_TIMEOUT_MS
CF_OVERALL_TIMEOUT_MS
```

Provision one temporary Access application, an exact-path bypass for `/.well-known/assetlinks.json`, a Tunnel to the loopback origin, dynamic public-client registration, and the matching App Link fingerprint. Configure the shortest practical Access session duration and record actual issue/expiry/refresh timestamps rather than simulating expiry. Require `CF_TOKEN_EXPIRY_TIMEOUT_MS` to exceed that real lifetime by at least 120 seconds, and `CF_OVERALL_TIMEOUT_MS` to exceed login timeout + expiry timeout + instrumentation cleanup margin.

Before launching OAuth, `run-real-gate.ts` executes:

```bash
adb -s "$ANDROID_SERIAL" shell pm verify-app-links --re-verify dev.clauderemote.probe
adb -s "$ANDROID_SERIAL" shell pm get-app-links dev.clauderemote.probe
```

It parses the second command and requires the exact probe hostname to be in verified state; browser fallback or merely declaring an intent filter does not pass.

The runner starts the loopback origin and a recorded `cloudflared tunnel --config "$CLOUDFLARED_CONFIG" run` child process, then launches `connectedDebugAndroidTest` without waiting synchronously for completion. It enforces separate login, token-expiry, instrumentation, and overall deadlines. It monitors the Android barrier file; once `ready-for-tunnel-stop` appears, it records the last origin request ID, stops the exact cloudflared process group, and sends the barrier-release broadcast. Android then retries HTTP and WebSocket with its refreshed still-valid bearer. Success requires no HTTP `2xx`, no WebSocket `101`, an expected Cloudflare Tunnel-unavailable edge response when the hostname still answers, and no origin request ID after the recorded boundary.

After instrumentation exits, the runner pulls final Android evidence, reads origin evidence, and verifies issuer/audience/subject, HTTP/WebSocket request IDs, genuinely expired old-token rejection, refresh/reconnect, raw TCP LAN refusal/timeout, and post-Tunnel barrier results. Any deadline, missing login/barrier/evidence, or child failure becomes validated `not_run`/`failed`. On timeout or error it terminates the exact Gradle, origin, and cloudflared process groups, stops outstanding adb commands, runs `adb shell am force-stop dev.clauderemote.probe`, and never leaves a probe process running.

- [ ] **Step 8: Run the real gate**

Run: `RUN_REAL_CLOUDFLARE=1 npx tsx probes/cloudflare/run-real-gate.ts`
Expected: validated evidence for OAuth discovery/registration/PKCE, App Link callback, bearer HTTP, bearer WebSocket Upgrade, expired-old-token rejection, real refresh/reconnect, LAN unreachability, and remote failure after the runner stops Tunnel. Failure blocks production Access/OAuth/remote transport; never substitute an embedded service token.

- [ ] **Step 9: Commit**

```bash
git add probes/cloudflare package.json package-lock.json
git commit -m "test: gate Cloudflare mobile access flow"
```

### Task 5: Produce the Phase 0 capability summary

**Files:**
- Modify: `package.json`
- Modify: `probes/run-phase0.ts`
- Test: `probes/run-phase0.test.ts`

- [ ] **Step 1: Add exact workspace gate scripts**

Add root scripts `phase0:claude: tsx probes/claude-code/run-real-gate.ts`, `phase0:transcript: tsx probes/transcript/run-real-gate.ts`, and `phase0:cloudflare: tsx probes/cloudflare/run-real-gate.ts`. Each wrapper owns subprocess timeouts and emits its evidence file. `phase0` only validates explicit evidence files and reports unlocked/blocked capabilities.

- [ ] **Step 2: Test failure mapping**

Use evidence fixtures for missing output, malformed evidence, nominal pass containing a failed check, and each independent gate failure. Separately test each gate script's adapter that converts its own subprocess nonzero exit, timeout, or missing runtime prerequisite into validated `failed`/`not_run` evidence. The aggregator itself only validates evidence files; no case may default to pass.

- [ ] **Step 3: Run deterministic verification**

Run: `npm test && npm run typecheck`
Expected: PASS for root and every configured workspace.

- [ ] **Step 4: Run available real gates and inspect the matrix**

Run: `npm run phase0 -- --claude build/phase0/claude.json --transcript build/phase0/transcript.json --cloudflare build/phase0/cloudflare.json`
Expected: `build/phase0/summary.json` accurately lists unlocked and blocked capabilities. Proceed only with tasks whose dependencies are unlocked.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json probes/run-phase0.ts probes/run-phase0.test.ts probes/gate-result.schema.json
git commit -m "test: enforce Phase 0 capability gates"
```

## Chunk 2: Bridge foundation

Goal: a runnable loopback Bridge skeleton with validated protocol models, durable command ledger, durable event journal, and the version-negotiated HTTP/WebSocket boundary. No Claude, auth, or permission logic yet — those land in Chunk 3.

### Task 6: Bridge workspace, configuration, and loopback health

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/tsconfig.json`
- Create: `bridge/vitest.config.ts`
- Create: `bridge/src/main.ts`
- Create: `bridge/src/config.ts`
- Create: `bridge/src/server/http-server.ts`
- Test: `bridge/test/config.test.ts`
- Test: `bridge/test/http-server.test.ts`

- [ ] **Step 1: Add the workspace and install dependencies**

`bridge/package.json`:

```json
{
  "name": "@claude-remote/bridge",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "canonicalize": "^2.0.0",
    "fastify": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "pino": "^9.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Extend `../../tsconfig.base.json`, include `src/**/*.ts` and `test/**/*.ts`, set `outDir: dist`. Add `bridge` to root `workspaces` and run `npm install`.

- [ ] **Step 2: Write the failing config test**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires loopback bind and rejects other interfaces", () => {
    const cfg = loadConfig({ BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: "/tmp/bridge-cfg-test" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(43111);
  });

  it("rejects non-loopback hosts", () => {
    expect(() => loadConfig({ BRIDGE_HOST: "0.0.0.0", BRIDGE_PORT: "43111", BRIDGE_DATA_DIR: "/tmp/x" }))
      .toThrow(/loopback/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @claude-remote/bridge -- config.test.ts`
Expected: FAIL because `loadConfig` is missing.

- [ ] **Step 4: Implement minimal validated config**

`config.ts` exposes a frozen `BridgeConfig` with `host` (only `127.0.0.1` or `::1`), `port`, `dataDir`, `databasePath`, and `auditLogPath`. Reject any non-loopback host, any `port` below 1024 or above 65535, and any `dataDir` that is not an absolute path. Resolve `dataDir` with `fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })` after validation.

- [ ] **Step 5: Write the failing HTTP test**

Assert `/api/v1/capabilities` returns `protocolVersion` (string `"claude-remote.v1"`), `bridgeVersion`, `minimumAndroidVersion`, `claudeCodeVersion` (return `null` until Chunk 3 wires the real value), `serverTime`, and `features: []`; `/api/v1/health` returns `{status:"ok"}`; requests to any path outside `/api/v1/` return 404; and the server binds to `127.0.0.1` only.

- [ ] **Step 6: Implement the minimal Fastify server**

`http-server.ts` exposes `startHttpServer(config, { capabilities })` returning the Fastify instance. Register routes for `/api/v1/health` and `/api/v1/capabilities`. Validate response bodies with the same Ajv validator used elsewhere.

- [ ] **Step 7: Implement the entry point**

`main.ts` loads config, starts the HTTP server, installs `SIGTERM`/`SIGINT` handlers that call `server.close()` and `process.exit(0)`, and never starts a Cloudflare Tunnel from inside the Bridge.

- [ ] **Step 8: Run focused verification**

Run: `npm test -w @claude-remote/bridge && npm run typecheck -w @claude-remote/bridge && npm run build -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bridge package.json package-lock.json
git commit -m "feat(bridge): add loopback http skeleton and config"
```

### Task 7: SQLite database, migrations, and transaction helper

**Files:**
- Create: `bridge/src/db/database.ts`
- Create: `bridge/src/db/migrations/001_initial.sql`
- Test: `bridge/test/db/database.test.ts`

- [ ] **Step 1: Write failing database tests**

Assert: opening the database creates the file with mode `0600`; `migrate()` is idempotent; `transaction(fn)` rolls back when `fn` throws; WAL journal mode is enabled; and every table from `001_initial.sql` exists with the expected columns.

Schema covers `projects`, `sessions`, `commands`, `pending_events`, `device_delivery`, `history_snapshots`, `history_snapshot_items`, `session_locks`, `devices`, `device_sessions`, `pairing_tokens`, `auth_challenges`, and `audit_events`. Use exactly the columns below:

```sql
-- 001_initial.sql
CREATE TABLE projects (
  projectId            TEXT PRIMARY KEY,
  canonicalRealpath    TEXT NOT NULL UNIQUE,
  deviceNumber         INTEGER NOT NULL,
  inode                INTEGER NOT NULL,
  displayName          TEXT NOT NULL,
  createdAt            INTEGER NOT NULL,
  authorizedAt         INTEGER NOT NULL
);

CREATE TABLE sessions (
  sessionId            TEXT PRIMARY KEY,
  projectId            TEXT NOT NULL REFERENCES projects(projectId),
  displayName          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
    'inactive','starting','idle','running','waiting_permission',
    'interrupting','releasing','interrupted','failed'
  )),
  source               TEXT NOT NULL CHECK (source IN ('bridge','imported')),
  lastClaudeVersion    TEXT,
  lastEventId          INTEGER NOT NULL DEFAULT 0,
  lastActivityAt       INTEGER NOT NULL,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE commands (
  requestId            TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL,
  sessionId            TEXT NOT NULL,
  idempotencyKey       TEXT NOT NULL,
  commandType          TEXT NOT NULL,
  payloadHash          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
    'accepted','dispatching','dispatched',
    'indeterminate','interrupted','completed','failed'
  )),
  resultJson           TEXT,
  createdAt            INTEGER NOT NULL,
  updatedAt            INTEGER NOT NULL,
  UNIQUE (deviceId, idempotencyKey)
);
CREATE INDEX idx_commands_session ON commands(sessionId);

CREATE TABLE pending_events (
  sessionId            TEXT NOT NULL,
  eventId              INTEGER NOT NULL,
  eventType            TEXT NOT NULL,
  payloadJson          TEXT NOT NULL,
  protocolVersion      TEXT NOT NULL,
  deleteAfter          INTEGER,
  createdAt            INTEGER NOT NULL,
  PRIMARY KEY (sessionId, eventId)
);

CREATE TABLE device_delivery (
  deviceId             TEXT NOT NULL,
  sessionId            TEXT NOT NULL,
  protocolVersion      TEXT NOT NULL,
  deliveryBase         INTEGER NOT NULL,
  deliveryWatermark    INTEGER NOT NULL,
  deliveryCheckpointWatermark INTEGER NOT NULL DEFAULT 0,
  pendingCheckpoint    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deviceId, sessionId)
);

CREATE TABLE history_snapshots (
  snapshotId           TEXT PRIMARY KEY,
  sessionId            TEXT NOT NULL,
  deviceId             TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('prepared','committed','expired')),
  historyRevision      TEXT NOT NULL,
  adapterVersion       TEXT NOT NULL,
  transcriptPath       TEXT NOT NULL,
  readByteLimit        INTEGER NOT NULL,
  deliveryBase         INTEGER NOT NULL,
  deliveryWatermark    INTEGER NOT NULL,
  sessionStatus        TEXT NOT NULL,
  pendingPermissionJson TEXT,
  commitIdempotencyKey TEXT,
  commitResultJson     TEXT,
  committedAt          INTEGER,
  createdAt            INTEGER NOT NULL,
  expiresAt            INTEGER NOT NULL
);

CREATE TABLE history_snapshot_items (
  snapshotId           TEXT NOT NULL REFERENCES history_snapshots(snapshotId),
  ordinal              INTEGER NOT NULL,
  historyItemId        TEXT NOT NULL,
  historyRevision      TEXT NOT NULL,
  payloadJson          TEXT NOT NULL,
  PRIMARY KEY (snapshotId, ordinal)
);

CREATE TABLE session_locks (
  sessionId            TEXT PRIMARY KEY,
  bridgeInstanceId     TEXT NOT NULL,
  processLeaseSecret   TEXT,
  processPid           INTEGER,
  processStartedAt     INTEGER,
  heartbeatAt          INTEGER NOT NULL
);

CREATE TABLE devices (
  deviceId             TEXT PRIMARY KEY,
  publicKeySpki        TEXT NOT NULL,
  accessSubject        TEXT NOT NULL,
  displayName          TEXT NOT NULL,
  pairedAt             INTEGER NOT NULL,
  revokedAt            INTEGER
);

CREATE TABLE device_sessions (
  tokenHash            TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL REFERENCES devices(deviceId),
  accessSubject        TEXT NOT NULL,
  expiresAt            INTEGER NOT NULL,
  revokedAt            INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE pairing_tokens (
  tokenHash            TEXT PRIMARY KEY,
  expiresAt            INTEGER NOT NULL,
  consumedAt           INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE auth_challenges (
  challengeId          TEXT PRIMARY KEY,
  deviceId             TEXT NOT NULL,
  accessSubject        TEXT NOT NULL,
  hostAscii            TEXT NOT NULL,
  challengeRaw         BLOB NOT NULL,
  expiresAt            INTEGER NOT NULL,
  consumedAt           INTEGER,
  createdAt            INTEGER NOT NULL
);

CREATE TABLE audit_events (
  auditId              INTEGER PRIMARY KEY AUTOINCREMENT,
  occurredAt           INTEGER NOT NULL,
  accessSubjectHash    TEXT,
  deviceId             TEXT,
  rayId                TEXT,
  sourceIp             TEXT,
  requestId            TEXT,
  operationType        TEXT NOT NULL,
  sessionId            TEXT,
  projectId            TEXT,
  resultCode           TEXT NOT NULL,
  toolCategory         TEXT,
  permissionDecision   TEXT,
  redactedDetail       TEXT
);

CREATE TABLE schema_migrations (
  version              INTEGER PRIMARY KEY,
  appliedAt            INTEGER NOT NULL
);
```

Add a column-existence test for every column name in the schema above.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- db/database.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement migration and transaction helper**

`database.ts` opens with `better-sqlite3`, sets `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`, and `busy_timeout = 5000`. `migrate()` applies `001_initial.sql` inside a transaction and records a `schema_migrations` row. `transaction(fn)` wraps `db.transaction(fn)` and never auto-commits on exception.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- db/database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/db bridge/test/db package.json package-lock.json
git commit -m "feat(bridge): add sqlite schema and transaction helper"
```

### Task 8: Protocol v1 models and validator

**Files:**
- Create: `contracts/v1/command.schema.json`
- Create: `contracts/v1/response.schema.json`
- Create: `contracts/v1/event.schema.json`
- Create: `bridge/src/protocol/v1/types.ts`
- Create: `bridge/src/protocol/v1/validator.ts`
- Test: `bridge/test/protocol/v1/validator.test.ts`

- [ ] **Step 1: Write JSON Schemas**

`command.schema.json` defines the envelope (`protocolVersion`, `requestId` uuid, `idempotencyKey` string, `commandType` enum from spec §8.2, `sessionId` nullable uuid, `sentAt` RFC3339, `payload` per-command discriminated union) and each payload variant.

`event.schema.json` requires `eventId` as a decimal-stringified unsigned 64-bit integer, plus every event type from spec §8.4.

`response.schema.json` requires `protocolVersion`, `requestId`, `responseType`, and conditional `commandStatus`.

- [ ] **Step 2: Write failing validator tests**

Assert: every accepted command payload validates; unknown `commandType` rejects; non-decimal `eventId` rejects; `sentAt` must pass `ajv-formats` `date-time` (RFC3339 with `Z` or explicit offset both accepted, anything else rejected); oversized payloads reject at 256 KiB.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- protocol/v1/validator.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement TypeScript models and validator**

`types.ts` exports discriminated unions mirroring the schemas. `validator.ts` compiles Ajv schemas once with `ajv-formats` and exposes `validateCommand`, `validateEvent`, `validateResponse`. Numeric `eventId` is always parsed to `bigint` after string validation. `protocolVersion` literal is the constant `"claude-remote.v1"`.

- [ ] **Step 5: Run verification**

Run: `npm test -w @claude-remote/bridge -- protocol/v1/validator.test.ts && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add contracts bridge/src/protocol bridge/test/protocol package.json package-lock.json
git commit -m "feat(protocol): add v1 schemas, types, and validator"
```

### Task 9: Command ledger with idempotency and transitions

**Files:**
- Create: `bridge/src/commands/command-ledger.ts`
- Test: `bridge/test/commands/command-ledger.test.ts`

- [ ] **Step 1: Write failing tests**

Assert in order:

1. First insert with `(deviceId, idempotencyKey)` succeeds with status `accepted`.
2. Same key with the same JCS payload hash returns the saved record without re-running side effects.
3. Same key with a different payload hash returns a conflict and never writes a new row.
4. Duplicate `requestId` across different keys rejects.
5. `transition()` from `accepted → dispatching`, `dispatching → dispatched`, `dispatched → completed`, `dispatched → failed`, `dispatching → indeterminate`, and `dispatched → indeterminate` succeed; illegal transitions reject.
6. Transition to a terminal state is irreversible.
7. Transitions are persisted in the same transaction as a `command.status.changed` event when requested.

Use a temporary on-disk SQLite file.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- commands/command-ledger.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the ledger**

`command-ledger.ts` exposes:

```ts
interface CommandLedger {
  accept(envelope: CommandEnvelope, deviceId: string, payloadHash: string): Promise<CommandRecord>;
  acceptDuplicate(envelope: CommandEnvelope, deviceId: string, payloadHash: string): Promise<{ kind: "replay"; record: CommandRecord } | { kind: "conflict" } | { kind: "inserted"; record: CommandRecord }>;
  transitionWithStatusEvent(
    requestId: string,
    next: CommandStatus,
    options: { buildEventPayload: (record: CommandRecord) => Omit<EventPayload, "eventId">; now: number }
  ): Promise<{ record: CommandRecord; event: PersistedEvent }>;
  get(requestId: string): Promise<CommandRecord | undefined>;
}
```

`transitionWithStatusEvent` must call `eventJournal.appendInside(db.transaction(() => { … }))` so the `commands` row update, `sessions.lastEventId` increment, and `pending_events` insert share one transaction. Add a `package.json` dependency `"canonicalize": "^2.0.0"` (RFC 8785 JCS) and use it for `payloadHash`. Write unit tests for `canonicalJson()` covering nested objects, integer vs float, key ordering under UTF-16 code unit rules, and surrogate pair keys.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- commands/command-ledger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/commands bridge/test/commands package.json package-lock.json
git commit -m "feat(bridge): add idempotent command ledger"
```

### Task 10: Event journal with high-water mark, ACK, and retention

**Files:**
- Create: `bridge/src/events/event-journal.ts`
- Test: `bridge/test/events/event-journal.test.ts`

- [ ] **Step 1: Write failing tests**

Assert:

1. `append()` increments `sessions.lastEventId` and inserts a `pending_events` row in the same transaction; the event is only sent after commit.
2. `eventId` is encoded as a decimal string in the persisted payload.
3. After all events are deleted, the next `append()` still produces a strictly increasing ID.
4. `replayAfter(sessionId, eventId)` yields events in order, excluding nothing in the unacknowledged window.
5. `acknowledge(sessionId, deviceId, eventId)` sets `pending_events.deleteAfter = now + 600` for every event up to and including `eventId`, and advances `device_delivery.deliveryWatermark` forward; backward ACK rejects.
6. `markCheckpointSuperseded(sessionId, deviceId, watermark)` sets `deleteAfter = now + 600` (not immediate deletion) on `eventId <= watermark` events; deletion still requires the configured retention delay.
7. `append()` with `category: "user_command"` throws `STORAGE_PRESSURE` when the configured byte budget for `pending_events` is exceeded, without modifying the journal; `append()` with `category: "system"` (e.g. `session.state.changed`, `command.status.changed`, `session.failed`, `session.interrupted`) bypasses the byte-budget check so terminal-state events always persist.
8. `truncateLargeToolOutput(payload, limit)` replaces any `tool.output.delta` payload whose UTF-8 byte length exceeds 65,536 with `{ truncated: true, originalByteCount: number, truncatedAt: "65KiB" }` and returns the truncated payload; non-tool-output events pass through unchanged.
9. A bridge restart (close + reopen) replays every unacknowledged event whose `deleteAfter` is `null` or greater than now; events whose `deleteAfter` has elapsed are removed during the start sweep.
10. The next sweep (invoked on every `append`) deletes any `pending_events` whose `deleteAfter <= now`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- events/event-journal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the journal**

`event-journal.ts` exposes:

```ts
type EventCategory = "user_command" | "system";

interface AppendOptions {
  category: EventCategory;
  sessionId: string;
  eventType: string;
  payload: EventPayload;
  now: number;
}

interface EventJournal {
  append(opts: AppendOptions): Promise<PersistedEvent>;
  appendInside<T>(tx: (db: Database) => T): T;  // exposes the active transaction for atomic cross-table writes
  replayAfter(sessionId: string, eventId: bigint): AsyncIterable<PersistedEvent>;
  acknowledge(sessionId: string, deviceId: string, eventId: bigint, now: number): Promise<void>;
  markCheckpointSuperseded(sessionId: string, deviceId: string, watermark: bigint, now: number): Promise<void>;
  truncateLargeToolOutput(payload: unknown, limit: number): { payload: unknown; truncated: boolean };
  pendingBytes(): number;
}
```

Constants (named in `config.ts`): `PENDING_EVENT_RETENTION_SECONDS = 600`, `TOOL_OUTPUT_BYTE_LIMIT = 65536`, `PENDING_EVENTS_BYTE_BUDGET` (configurable, default 64 MiB).

`append` checks the byte budget only when `category === "user_command"` and only before any allocation. `acknowledge` sets `deleteAfter = now + PENDING_EVENT_RETENTION_SECONDS` on every event up to and including `eventId`, never deletes immediately. A sweep on `append` and on Bridge start removes any row with `deleteAfter IS NOT NULL AND deleteAfter <= now`. `appendInside` lets callers (the command ledger) drive a single transaction that wraps the `commands` update, the `sessions.lastEventId` increment, and the `pending_events` insert.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- events/event-journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/events bridge/test/events package.json package-lock.json
git commit -m "feat(bridge): add durable event journal and ack semantics"
```

### Task 11: WebSocket server, subprotocol, and close codes

**Files:**
- Create: `bridge/src/server/websocket-server.ts`
- Test: `bridge/test/server/websocket-server.test.ts`

- [ ] **Step 1: Write failing tests**

Use `ws` as a test client against the in-process Fastify server.

Assert:

1. Missing `Sec-WebSocket-Protocol: claude-remote.v1` rejects the Upgrade.
2. Missing `Authorization` and `X-Claude-Remote-Device-Session` reject with `4401` (auth wiring lands in Chunk 3; here the server treats them as required headers without verifying content).
3. `protocolVersion` mismatch returns `4426`.
4. Server may close with `4401`, `4403`, `4409`, `4410`, `4426`, or `4500` per spec §8.1.
5. Each event delivered carries a decimal `eventId`.
6. Concurrent socket from a second "device" is rejected (single paired device enforcement is a stub for now, returning `4403`).

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- server/websocket-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the WebSocket boundary**

`websocket-server.ts` registers `@fastify/websocket`, verifies subprotocol selection, enforces required headers, and exposes a `SessionConnection` abstraction that:

- holds the underlying socket;
- tracks the device/session association set during auth (initially `null`);
- exposes `send(event)` that writes a single JSON message and flushes;
- exposes `close(code, reason)` that closes with one of the documented codes (`4401`, `4403`, `4409`, `4410`, `4426`, `4500`);
- during Chunk 2 stub auth, accepts any non-empty `Authorization` and `X-Claude-Remote-Device-Session` value;
- enforces a write deadline based on Access assertion and device-session expiry once Chunk 3 wires those in.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- server/websocket-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/server bridge/test/server package.json package-lock.json
git commit -m "feat(bridge): add websocket subprotocol and close codes"
```

### Task 12: Bridge main wiring and smoke test

**Files:**
- Modify: `bridge/src/main.ts`
- Modify: `bridge/src/server/http-server.ts`
- Modify: `bridge/src/server/websocket-server.ts`
- Test: `bridge/test/main.smoke.test.ts`

- [ ] **Step 1: Write a smoke test**

Boot `main.ts` against a temp data dir and assert: `/api/v1/health` returns ok; `/api/v1/capabilities` reports `protocolVersion: "claude-remote.v1"` and includes `claudeCodeVersion` (null placeholder acceptable for now); a WebSocket Upgrade with `Sec-WebSocket-Protocol: claude-remote.v1`, `Authorization: Bearer stub`, and `X-Claude-Remote-Device-Session: stub` connects; missing either header closes with `4401`; closing the socket does not crash the server; `SIGTERM` triggers clean shutdown within 2 seconds.

- [ ] **Step 2: Run the smoke test**

Run: `npm test -w @claude-remote/bridge -- main.smoke.test.ts`
Expected: PASS.

- [ ] **Step 3: Run all Bridge tests and typecheck**

Run: `npm test -w @claude-remote/bridge && npm run typecheck -w @claude-remote/bridge && npm run build -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bridge package.json package-lock.json
git commit -m "feat(bridge): wire main entrypoint and smoke verification"
```

## Chunk 3: Bridge runtime

Goal: turn the Bridge skeleton into a working server. After Chunk 3, the Bridge can authorize projects, own Claude Code subprocesses, route permission prompts through an MCP adapter, import/snapshot history, enforce two-phase resync, verify Cloudflare Access and device signatures, emit redacted audit records, and expose a local admin CLI. Each task lists the spec section it implements.

Prerequisite: Phase 0 gates for the capabilities being added must be unlocked in `build/phase0/summary.json`.

### Task 13: Project registry and identity revalidation

**Files:**
- Create: `bridge/src/projects/project-registry.ts`
- Test: `bridge/test/projects/project-registry.test.ts`
- Spec reference: §6.6, §10.5.

- [ ] **Step 1: Write failing tests**

Assert:

1. `authorize(path, displayName)` resolves realpath, records `projectId`, canonical realpath, st_dev, st_ino, and displayName, and rejects symlinks at the authorized root.
2. `revalidate(projectId)` re-resolves realpath and rejects when the canonical path changed, st_dev changed, st_ino changed, or the directory is missing.
3. Revalidate accepts symlinks *inside* the project (no security boundary claim), but rejects a replaced root.
4. `list()` returns only projects not revoked.
5. Two projects with the same realpath reject.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- projects/project-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the registry**

Use `fs.realpath.native` for canonical resolution, `fs.statSync` for `dev`/`ino`, and `crypto.randomUUID()` for project IDs. The registry never returns raw paths to the client; only `projectId`.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- projects/project-registry.test.ts && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/projects bridge/test/projects package.json package-lock.json
git commit -m "feat(bridge): add project registry with identity revalidation"
```

### Task 14: Session state machine

**Files:**
- Create: `bridge/src/sessions/session-state-machine.ts`
- Test: `bridge/test/sessions/session-state-machine.test.ts`
- Spec reference: §7.1, §7.5.

- [ ] **Step 1: Write failing tests**

Assert every legal transition from §7.1 (`inactive→starting`, `starting→idle|failed`, `idle→running`, `running→idle|waiting_permission|interrupting|failed`, `waiting_permission→running|interrupting`, `interrupting→interrupted|failed`, `interrupted→releasing|starting`, `idle→releasing`, `releasing→inactive`) and reject every other transition. Assert terminal `failed` and `inactive` are not auto-left.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- sessions/session-state-machine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the state machine**

`session-state-machine.ts` exports a pure `canTransition(from, to): boolean` plus `assertTransition(from, to)`. Keep it pure (no DB, no I/O) so it can be reused by tests, the supervisor, and the snapshot writer.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- sessions/session-state-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/sessions bridge/test/sessions package.json package-lock.json
git commit -m "feat(bridge): add session state machine"
```

### Task 15: Session supervisor with fake Claude process

**Files:**
- Create: `bridge/src/sessions/session-supervisor.ts`
- Create: `bridge/src/sessions/session-locks.ts`
- Test: `bridge/test/sessions/session-supervisor.test.ts`
- Spec reference: §6.3, §7.2, §7.3, §7.5, §7.6.

- [ ] **Step 1: Write failing tests against a fake process**

Assert using a stub `ClaudeProcessFactory`:

1. `createSession` generates a UUID, writes session+lock+lease in one transaction, starts the process in the project directory, and rejects if `system/init.session_id` does not match the generated UUID.
2. `resumeSession` requires `idle` or `interrupted`, obtains the Bridge-wide write lock, reuses a healthy same-instance process, otherwise starts `--resume`, and validates init session_id.
3. `stop` resolves pending permissions as denied, sends `SIGINT`, waits 5 s, `SIGTERM`, waits 5 s, `SIGKILL`; final state `interrupted`.
4. `release` is only legal in `idle`/`interrupted`; it closes stdin, waits for transcript stabilization, releases the lock; final state `inactive`.
5. `cancel` rejects for already-dispatched commands.
6. Reconcile-on-restart: stale leases from another Bridge instance are expired; PID identity mismatch does not signal.
7. Concurrent supervisor instances on the same session conflict via `session_locks`.

Note: §7.6 step 6 transcript-evidence reconciliation depends on the history adapter (Task 19). `recoverOnStartup` here only expires stale leases and stops mismatched PIDs; it leaves `dispatching`/`dispatched` commands untouched and exposes `reconcileIndeterminateCommands(history)` for Task 19 to call once `findTurnEvidence` exists.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- sessions/session-supervisor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the supervisor**

`session-supervisor.ts` exposes:

```ts
interface SessionSupervisor {
  createSession(input: { projectId: string; displayName?: string }): Promise<{ sessionId: string }>;
  resumeSession(input: { sessionId: string }): Promise<void>;
  stop(input: { sessionId: string }): Promise<void>;
  release(input: { sessionId: string }): Promise<void>;
  cancel(input: { requestId: string }): Promise<void>;
  recoverOnStartup(): Promise<void>;
  reconcileIndeterminateCommands(history: { findTurnEvidence(sessionId: string, uuid: string): Promise<TurnEvidence> }): Promise<void>;
}
```

Process launches are delegated to a `ClaudeProcessFactory` interface so tests can inject a fake; the real factory is wired in Task 16. Stop/release timing constants (5 s each) come from `config.ts`. Transcript stabilization = file size unchanged across three 200 ms observations or 5 s timeout. `recoverOnStartup` is split: lease cleanup here; command reconciliation deferred to Task 19 via `reconcileIndeterminateCommands`.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- sessions/session-supervisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/sessions bridge/test/sessions package.json package-lock.json
git commit -m "feat(bridge): add session supervisor with fake process"
```

### Task 16: Claude stream-json adapter and process lease

**Files:**
- Create: `bridge/src/claude/stream-json-adapter.ts`
- Create: `bridge/src/claude/process-lease-wrapper.ts`
- Create: `bridge/src/claude/process-factory.ts`
- Test: `bridge/test/claude/stream-json-adapter.test.ts`
- Test: `bridge/test/claude/process-lease-wrapper.test.ts`
- Spec reference: §4, §6.3, §7.6.
- Prerequisite: Phase 0 Claude gate must be `passed`.

- [ ] **Step 1: Write failing parser tests**

Use the candidate envelope from Phase 0 as the input fixture. Assert:

1. `sendUser(uuid, sessionId, text)` writes exactly one NDJSON line whose JSON equals the candidate shape.
2. `events()` yields parsed objects, buffering partial lines until newline.
3. `system/init` extraction returns `session_id`.
4. Unknown event types yield a typed `unknownClaudeEvent` object instead of throwing.
5. `result` does not auto-close the process; only stdin close or supervisor command does.
6. Resume mode never combines `--session-id` with `--resume`.
7. Permission-prompt tool name is configurable from `--permission-prompt-tool` flag value.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- claude/stream-json-adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the adapter**

`stream-json-adapter.ts` builds the exact Phase 0 spawn args, manages stdin/stdout, exposes `sendUser`/`closeInput`/`events`/`awaitInit`. The user-message envelope written to stdin matches the Phase 0 candidate exactly, including `parent_tool_use_id: null`. `process-factory.ts` is the real `ClaudeProcessFactory` implementation; it reads the configured `claude` binary path, generates a per-session MCP config with absolute paths and `--strict-mcp-config`, generates a 256-bit lease secret passed to the subprocess via the `BRIDGE_LEASE_SECRET` env var, and includes `BRIDGE_LEASE_SECRET` in the deny-list used by any future env-logging helper.

- [ ] **Step 4: Write process-lease-wrapper tests**

Assert: when the named control pipe closes (Bridge crash simulation), the wrapper sends `SIGINT`, waits 5 s, `SIGTERM`, waits 5 s, `SIGKILL` to the entire process group. When the Claude process exits cleanly, the wrapper returns without signalling.

- [ ] **Step 5: Implement the lease wrapper**

`process-lease-wrapper.ts` watches a `0600` FIFO created by Bridge. Each child Claude process gets a unique 256-bit lease secret via env var, validated on every MCP adapter connection (Task 17).

- [ ] **Step 6: Run verification**

Run: `npm test -w @claude-remote/bridge -- claude/ && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

Run real-CLI smoke (optional, opt-in): `RUN_REAL_CLAUDE=1 npm test -w @claude-remote/bridge -- claude/stream-json-adapter.real.test.ts`
Expected: PASS against a temporary project; otherwise return to Phase 0 findings.

- [ ] **Step 7: Wire the factory into the supervisor**

Replace the fake factory default with `process-factory.ts` and add one integration test that starts and stops a real local fake Claude binary (committed under `bridge/test/fixtures/fake-claude.mjs`) to verify end-to-end ownership without depending on the proprietary CLI.

- [ ] **Step 8: Commit**

```bash
git add bridge/src/claude bridge/test/claude bridge/test/fixtures package.json package-lock.json
git commit -m "feat(bridge): add claude stream-json adapter and lease wrapper"
```

### Task 17: Permission broker

**Files:**
- Create: `bridge/src/permissions/permission-broker.ts`
- Create: `bridge/src/permissions/socket-protocol.ts`
- Test: `bridge/test/permissions/permission-broker.test.ts`
- Spec reference: §6.4, §9, §11.5.

- [ ] **Step 1: Write failing tests**

Assert:

1. Adapter authenticates with the per-process 256-bit lease secret; mismatched secret closes the socket without response.
2. The same lease secret cannot be used twice; a second adapter connection with the same secret rejects, enforcing single-use semantics.
3. A lease secret bound to session A cannot be used to bind the adapter to session B; mismatched `sessionId` rejects.
4. Pending request stored in `pending_events` and visible to the active device within 200 ms.
5. `permission.resolve` from the correct device+session returns allow/deny; same request twice rejects the second.
6. Five-minute timeout auto-denies.
7. `session.stop` resolves pending as denied.
8. Bridge graceful shutdown resolves every pending request as denied.
9. Device revocation resolves pending as denied.
10. Allow returns the original `input` verbatim; deny returns user/timeout message with `interrupt: false`.
11. Adapter crash, socket close, or broker-reachable-but-MCP-write-fails denies the current pending request, and when the deny cannot be delivered the broker terminates the bound Claude subprocess group.
12. MCP result schema mismatch (missing `behavior`, or unknown behavior) denies and terminates the subprocess.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- permissions/permission-broker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the broker**

`socket-protocol.ts` defines length-prefixed JSON frames over a `0600` Unix domain socket at a path under the Bridge data dir. `permission-broker.ts` exposes:

```ts
interface PermissionBroker {
  registerAdapter(leaseSecret: string, sessionId: string): Promise<AdapterConnection>;
  request(input: PermissionRequestInput): Promise<PermissionDecision>;
  resolve(input: { permissionRequestId: string; decision: PermissionDecision }): Promise<void>;
  denyAllForSession(sessionId: string, reason: string): Promise<void>;
  denyAllForDevice(deviceId: string, reason: string): Promise<void>;
}
```

The five-minute timeout is configurable in `config.ts`. The broker never returns `updatedPermissions`, so no permanent allow rules can be created.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- permissions/ && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/permissions bridge/test/permissions package.json package-lock.json
git commit -m "feat(bridge): add permission broker and socket protocol"
```

### Task 18: Standalone Permission MCP adapter

**Files:**
- Create: `bridge/src/permission-adapter/main.ts`
- Create: `bridge/src/permission-adapter/mcp-server.ts`
- Create: `bridge/src/permission-adapter/package.json`
- Test: `bridge/test/permission-adapter/mcp-server.test.ts`
- Spec reference: §6.4.
- Prerequisite: Phase 0 Claude gate must be `passed` (verifies the MCP protocol shape).

- [ ] **Step 1: Add the standalone executable workspace**

`bridge/src/permission-adapter/package.json` declares `bin.cjs` and is referenced from Bridge-generated MCP configs by absolute path. Build copies the bundled adapter into `bridge/dist/permission-adapter/`.

- [ ] **Step 2: Write failing tests**

Assert:

1. As an MCP stdio server, registers one tool whose input schema matches §6.4.
2. Returns a single text content block with the JSON decided by the broker.
3. Includes `toolUseID` only when the original request had `tool_use_id`.
4. Lease secret read from env; missing or wrong secret closes stdio without forwarding to the broker.
5. Bridge socket unreachable: returns deny with `message: "bridge_unavailable"` and exits nonzero.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- permission-adapter/`
Expected: FAIL.

- [ ] **Step 4: Implement the adapter**

Use `@modelcontextprotocol/sdk`. The adapter reads `BRIDGE_PERMISSION_SOCKET`, `BRIDGE_LEASE_SECRET`, `BRIDGE_SESSION_ID` from env; never logs secrets; and forwards each `permission_prompt` call to the broker, returning the broker's JSON as one MCP text content block.

- [ ] **Step 5: Run verification**

Run: `npm test -w @claude-remote/bridge -- permission-adapter/ && npm run build -w @claude-remote/bridge`
Expected: PASS and produces `bridge/dist/permission-adapter/main.cjs`.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/permission-adapter bridge/test/permission-adapter bridge/package.json package-lock.json
git commit -m "feat(bridge): add standalone permission mcp adapter"
```

### Task 19: History adapter, importer, and snapshot service

**Files:**
- Create: `bridge/src/history/claude-2.1.133-adapter.ts`
- Create: `bridge/src/history/session-importer.ts`
- Create: `bridge/src/snapshots/snapshot-service.ts`
- Test: `bridge/test/history/claude-2.1.133-adapter.test.ts`
- Test: `bridge/test/history/session-importer.test.ts`
- Test: `bridge/test/snapshots/snapshot-service.test.ts`
- Spec reference: §6.6, §6.7, §8.5.
- Prerequisite: Phase 0 transcript gate must be `passed`.

- [ ] **Step 1: Write failing adapter tests**

Promote the Phase 0 probe adapter to production shape. Assert: `readMetadata`, `readSnapshot(byteLimit)` ends at last complete newline, `findTurnEvidence(uuid)` returns the union `complete|interrupted|absent|incompatible`. Add tests for the production error paths (path not under authorized project, missing file, oversized byte limit).

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- history/claude-2.1.133-adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement adapter and importer**

The importer scans only the bound project's transcript directory, requires valid UUID filenames, deduplicates by session ID, and persists bindings atomically.

- [ ] **Step 4: Write failing snapshot-service tests**

Assert the full §6.7 protocol:

1. `begin()` takes the resync mutex, captures `deliveryBase`, `deliveryWatermark`, current session state, all non-terminal commands, and pending permission; returns first page + cursor.
2. While `prepared` exists for the device, `events.ack` past `deliveryBase` returns `409 CHECKPOINT_COMMIT_REQUIRED`.
3. `page(cursor)` returns subsequent pages from materialized items; expired cursor returns `410 SNAPSHOT_EXPIRED` and does not change delivery.
4. `commit(snapshotId, historyRevision, deliveryWatermark, idempotencyKey)` advances `device_delivery` only after atomically validating all three fields, sets snapshot `status = committed`, persists `commitIdempotencyKey`/`commitResultJson`/`committedAt`, advances `device_delivery.deliveryCheckpointWatermark`, and marks superseded events' `deleteAfter`.
5. Duplicate commit with the same `idempotencyKey` returns the persisted `commitResultJson` and performs no further state change.
6. Same `idempotencyKey` with different fields returns a conflict and performs no state change.
7. `commit` after `expireStale` has flipped the snapshot to `expired` returns `410 SNAPSHOT_EXPIRED` regardless of wall-clock timing.
8. `expireStale(now)` invoked on `begin`, `commit`, and Bridge start flips rows whose `expiresAt <= now` from `prepared` to `expired`; expired rows never advance delivery.
9. Buffer events during `prepared` get `eventId > deliveryWatermark` after mutex release.

- [ ] **Step 5: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- snapshots/snapshot-service.test.ts`
Expected: FAIL.

- [ ] **Step 6: Implement the snapshot service**

`snapshot-service.ts` exposes `begin/page/commit/expireStale`. Duplicate commit recognition reads `commitIdempotencyKey` from the snapshot row; on first commit it persists `commitIdempotencyKey`, `commitResultJson`, and `committedAt` in the same transaction that flips status to `committed`. Expiry is a sweep invoked on `begin`/`commit` and on Bridge start; expired snapshots do not advance delivery and do not delete events. After successful commit, `reconcileIndeterminateCommands` (Task 15) is called by Task 24 wiring using the production history adapter to satisfy §7.6 step 6.

- [ ] **Step 7: Run verification**

Run: `npm test -w @claude-remote/bridge -- history/ snapshots/ && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bridge/src/history bridge/src/snapshots bridge/test/history bridge/test/snapshots package.json package-lock.json
git commit -m "feat(bridge): add history importer and two-phase snapshot service"
```

### Task 20: Cloudflare Access JWT verifier

**Files:**
- Create: `bridge/src/auth/access-jwt-verifier.ts`
- Test: `bridge/test/auth/access-jwt-verifier.test.ts`
- Spec reference: §10.2.
- Prerequisite: Phase 0 Cloudflare gate must be `passed`.

- [ ] **Step 1: Write failing tests**

Use a signed test JWT (jose `SignJWT`). Assert: signature, issuer (`https://<team>.cloudflareaccess.com`), audience (`aud` from config), subject presence, and `exp` enforcement. Reject missing assertion, expired, wrong issuer, wrong audience, and missing subject.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- auth/access-jwt-verifier.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the verifier**

`access-jwt-verifier.ts` reads `Cf-Access-Jwt-Assertion` header, decodes without trusting unverified claims, fetches Cloudflare Access JWKS for the configured team domain with caching and refresh on unknown `kid`, and returns `{ subject, audience, expiresAt }`. The verifier never logs the assertion body.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- auth/access-jwt-verifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/auth bridge/test/auth package.json package-lock.json
git commit -m "feat(bridge): add cloudflare access jwt verifier"
```

### Task 21: Device auth, pairing, challenge, sessions, revocation

**Files:**
- Create: `bridge/src/auth/signing-bytes.ts`
- Create: `bridge/src/auth/device-auth.ts`
- Test: `bridge/test/auth/signing-bytes.test.ts`
- Test: `bridge/test/auth/device-auth.test.ts`
- Spec reference: §10.3, §10.4.
- Prerequisite: Phase 0 Cloudflare gate must be `passed`.

- [ ] **Step 1: Generate and validate the shared auth-signing fixture**

Add `bridge/scripts/gen-auth-fixture.ts` (one-shot) that uses a hard-coded P-256 test keypair to emit `contracts/v1/auth-signing-fixture.json` containing: SPKI DER (base64), deviceId, canonical host, Access subject, challenge ID, challenge raw bytes, the exact signing-content as hex, and a fixed DER signature produced deterministically (RFC6979 nonce) so both implementations verify the same bytes. Run it once, commit the JSON, never regenerate.

Then write failing tests asserting: `buildSigningBytes()` output equals the fixture hex byte-for-byte; `normalizeHost()` performs IDNA ToASCII, lowercase, no trailing dot; and inputs with userinfo, query, fragment, non-https scheme, non-empty path other than `/`, or ports other than empty/443 all reject.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- auth/signing-bytes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement signing-bytes**

`signing-bytes.ts` exports `normalizeHost(input: string): string` and `buildSigningBytes(input: { hostAscii: string; deviceId: string; challengeId: string; accessSubject: string; challengeRaw: Buffer }): Buffer`. Pure functions, no I/O.

- [ ] **Step 4: Write failing device-auth tests**

Assert the full pairing + challenge + session lifecycle:

1. Pairing token consumed atomically; replay rejects.
2. SPKI DER parse rejects non-P-256, invalid curve point, mismatched deviceId.
3. Challenge response includes `challengeId`, `challengeRaw`, `accessSubject` from the verified JWT.
4. `accessSubject` echoed back must match challenge record and current assertion.
5. ECDSA DER signature verification; `1 <= r,s < n`.
6. Device session token 15 min, hashed storage.
7. Refresh requires fresh challenge signature.
8. Revocation deletes device sessions and challenges, denies pending permissions, closes active sockets.
9. Only one paired device; new pairing requires prior revocation.

- [ ] **Step 5: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- auth/device-auth.test.ts`
Expected: FAIL.

- [ ] **Step 6: Implement device-auth**

Use Node `crypto` for P-256/SPKI parsing and ECDSA verification, and the registry pattern from §6.5. Token generation uses `crypto.randomBytes(32)`. Token hashes are SHA-256.

- [ ] **Step 7: Run verification**

Run: `npm test -w @claude-remote/bridge -- auth/ && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bridge/src/auth bridge/test/auth contracts package.json package-lock.json
git commit -m "feat(bridge): add device pairing, challenge, and session auth"
```

### Task 22: Audit log

**Files:**
- Create: `bridge/src/audit/audit-log.ts`
- Test: `bridge/test/audit/audit-log.test.ts`
- Spec reference: §10.6, §11.

- [ ] **Step 1: Write failing tests**

Assert: file mode `0600`; rotation at 10 MiB; five rotated files retained; thirty-day cap; redaction of `Authorization`, `Cf-Access-Jwt-Assertion`, `X-Claude-Remote-Device-Session`, OAuth tokens, API keys, file paths inside prompts, stderr tokens, and any string matching a generic credential pattern (`sk-[A-Za-z0-9]{20,}`, `Bearer [A-Za-z0-9._-]+`, `AKIA[0-9A-Z]{16}`, and high-entropy base64 longer than 32 chars). Assert structured fields per §10.6 and that prompts/full tool params/tool outputs never enter the log.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- audit/audit-log.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the audit log**

JSONL writer with synchronous `fs.appendFileSync`, atomic rotation via `fs.renameSync`, and a tested `redact(input: unknown): string` helper. Audit entries are written inside the same transactions that change command/session state when both are available, otherwise after the action with a `committed` flag.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- audit/audit-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/audit bridge/test/audit package.json package-lock.json
git commit -m "feat(bridge): add redacted rotating audit log"
```

### Task 23: Admin CLI

**Files:**
- Create: `bridge/src/admin/cli.ts`
- Test: `bridge/test/admin/cli.test.ts`
- Spec reference: §10.4, §10.5.

- [ ] **Step 1: Write failing CLI tests**

Assert subcommands:

- `bridge admin authorize-project <path> <displayName>` — adds an authorized project.
- `bridge admin list-projects` — lists project IDs and paths.
- `bridge admin revoke-project <projectId>`.
- `bridge admin list-devices` / `revoke-device <deviceId>` / `revoke-all-devices`.
- `bridge admin pairing-qrcode` — generates a fresh five-minute token and prints the QR.
- `bridge admin preflight` — checks loopback bind, data dir, Tunnel-only exposure, and verifies Cloudflare Access JWKS reachability.

All commands require `BRIDGE_DATA_DIR` env and refuse to bind any non-loopback interface.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w @claude-remote/bridge -- admin/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the CLI**

Use `commander` (add to dependencies). The CLI shares `loadConfig` with the server and never opens a Cloudflare Tunnel itself.

- [ ] **Step 4: Run verification**

Run: `npm test -w @claude-remote/bridge -- admin/ && npm run typecheck -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/admin bridge/test/admin bridge/package.json package-lock.json
git commit -m "feat(bridge): add local admin cli"
```

### Task 24: Wire Bridge runtime into main and end-to-end Chunk 3 verification

**Files:**
- Modify: `bridge/src/main.ts`
- Modify: `bridge/src/server/http-server.ts`
- Modify: `bridge/src/server/websocket-server.ts`
- Test: `bridge/test/runtime.integration.test.ts`

- [ ] **Step 1: Write failing runtime integration tests**

A single fake-Claude end-to-end test asserts: project authorization; session create/resume/stop/release; permission prompt round trip with allow and deny; command `dispatching → dispatched → completed` with `command.status.changed` events persisted; snapshot begin/page/commit with Room-equivalent state machine; revocation closes sockets; audit log redaction. Additionally:

- A forced `4410` resync flow: client state diverges, server returns `4410`, client runs `snapshot.begin → page → commit`, and live events with `eventId > deliveryWatermark` apply afterward without re-triggering `4410`.
- §7.6 reconciliation: kill the Bridge mid-`dispatched` command, restart, run `recoverOnStartup()` and `reconcileIndeterminateCommands(history)`, and assert `dispatching`/`dispatched` commands classify into `completed`/`failed`/`interrupted`/`indeterminate` per transcript evidence.
- Graceful shutdown: with an active session, `SIGTERM` triggers pending-permission denial, then the SIGINT → 5 s → SIGTERM → 5 s → SIGKILL stop order, ending in `interrupted`.

- [ ] **Step 2: Wire everything in `main.ts`**

Compose: config → database → audit log → event journal → command ledger → project registry → session supervisor (real factory) → permission broker → snapshot service → access verifier → device auth → HTTP routes → WebSocket handlers → SIGTERM/SIGINT graceful shutdown.

- [ ] **Step 3: Replace WebSocket stub auth**

WebSocket and HTTP request handlers now require valid Access assertion and device session; the stub accept-any path is removed.

- [ ] **Step 4: Run full Bridge verification**

Run: `npm test -w @claude-remote/bridge && npm run typecheck -w @claude-remote/bridge && npm run build -w @claude-remote/bridge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge package.json package-lock.json
git commit -m "feat(bridge): wire runtime and integrate verification"
```

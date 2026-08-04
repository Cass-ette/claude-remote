import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * Phase 0 evidence aggregator.
 *
 * This module NEVER launches any gate subprocess. It only consumes JSON
 * evidence files that the per-gate `run-real-gate.ts` wrappers (added in
 * later tasks) write under `build/phase0/`. The aggregator's job is to:
 *
 *   1. Validate each evidence file against the {@link GateResult} schema.
 *   2. Demote a nominal `status: "passed"` whose `checks` contains any
 *      `passed: false` entry to `failed`.
 *   3. Map the per-gate verdict to the capabilities it unblocks, using the
 *      dependency matrix defined below.
 *
 * Subprocess timeout / nonzero exit / missing-prerequisite handling lives
 * in each gate's own `run-real-gate.ts`; here we only turn missing files,
 * unreadable files, JSON parse errors, and schema violations into
 * `failed` evidence.
 */

export type GateName = "claude" | "transcript" | "cloudflare";
export type GateStatus = "passed" | "failed" | "not_run";

export interface GateCheck {
  name: string;
  passed: boolean;
  details?: string;
}

export type EvidenceValue = string | number | boolean;

export interface GateResult {
  name: GateName;
  status: GateStatus;
  startedAt: string;
  finishedAt: string;
  checks: GateCheck[];
  evidence: Record<string, EvidenceValue>;
}

export interface GateSummary {
  unlocked: string[];
  blocked: string[];
  results: GateResult[];
}

/**
 * Dependency matrix: which capabilities each gate unlocks when it passes.
 * Derived here, not a global boolean — a capability is unlocked only by the
 * specific gate that owns it.
 */
export const CAPABILITY_MATRIX: Readonly<Record<GateName, readonly string[]>> = {
  claude: [
    "stream-json-adapter",
    "session-supervisor",
    "permission-broker",
    "mcp-adapter",
    "uuid-retry"
  ],
  transcript: ["history-import", "history-snapshot", "crash-reconciliation"],
  cloudflare: ["remote-transport", "access-verifier", "oauth-device-auth"]
};

export const GATE_NAMES: readonly GateName[] = ["claude", "transcript", "cloudflare"];

/**
 * Demote a nominal `passed` status to `failed` if any of its checks reports
 * `passed: false`. The original {@link GateResult} object is not mutated;
 * a normalized copy is returned.
 *
 * Note: a `not_run` or `failed` result is returned as-is even if it also has
 * failing checks — demotion only applies to a nominally-passed gate, since
 * that is the case where the inconsistency would otherwise let a broken
 * capability slip through.
 */
function normalizeResult(input: GateResult): GateResult {
  if (input.status !== "passed") {
    return input;
  }
  const hasFailedCheck = input.checks.some((c) => !c.passed);
  if (!hasFailedCheck) {
    return input;
  }
  return { ...input, status: "failed" };
}

/**
 * Aggregate gate results into unlocked/blocked capability sets.
 *
 * A capability is unlocked only when its owning gate has a normalized status
 * of `passed` (i.e. nominally passed AND every check also reports
 * `passed: true`). Missing gates contribute no unlocked capabilities and
 * every capability they own ends up in `blocked`.
 *
 * The returned `results` array preserves the caller-supplied objects for the
 * gates that were passed in (other gates are unaffected). Demotion is
 * reflected in the returned results so callers can see why a capability was
 * blocked.
 */
export function summarizeGates(results: readonly GateResult[]): GateSummary {
  const byName = new Map<GateName, GateResult>();
  const normalized: GateResult[] = [];
  for (const r of results) {
    const n = normalizeResult(r);
    byName.set(n.name, n);
    normalized.push(n);
  }

  const unlocked: string[] = [];
  const blocked: string[] = [];
  for (const gate of GATE_NAMES) {
    const capabilities = CAPABILITY_MATRIX[gate];
    const result = byName.get(gate);
    const isUnlocked = result?.status === "passed";
    for (const cap of capabilities) {
      if (isUnlocked) {
        unlocked.push(cap);
      } else {
        blocked.push(cap);
      }
    }
  }

  return { unlocked, blocked, results: normalized };
}

// ---------------------------------------------------------------------------
// Evidence loading + schema validation
// ---------------------------------------------------------------------------

let cachedValidator: ValidateFunction<GateResult> | null = null;

function schemaPath(): string {
  // Resolve relative to this source file so the CLI works regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "gate-result.schema.json");
}

function getValidator(): ValidateFunction<GateResult> {
  if (cachedValidator) {
    return cachedValidator;
  }
  const schema = JSON.parse(readFileSync(schemaPath(), "utf8")) as object;
  // allowUnionTypes: silence Ajv strict-mode warning for the intentional
  // `["string","number","boolean"]` union in `evidence.additionalProperties`.
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  const validator = ajv.compile<GateResult>(schema);
  cachedValidator = validator;
  return validator;
}

/**
 * Load and validate a single evidence file.
 *
 * Returns `{ ok: true, result }` on success, or `{ ok: false, reason }` if the
 * file is missing, contains malformed JSON, or fails schema validation. The
 * caller decides how to surface the failure (typically as a synthesized
 * `failed` {@link GateResult}).
 */
export async function loadEvidence(path: string): Promise<
  | { ok: true; result: GateResult }
  | { ok: false; reason: string }
> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `cannot read ${path}: ${(err as NodeJS.ErrnoException).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `malformed JSON in ${path}: ${(err as Error).message}` };
  }
  const validator = getValidator();
  if (!validator(parsed)) {
    const messages = (validator.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
      .join("; ");
    return { ok: false, reason: `schema violation in ${path}: ${messages}` };
  }
  return { ok: true, result: parsed };
}

/**
 * Build a `not_run` evidence record for a gate whose evidence path was not
 * supplied on the CLI.
 */
export function synthesizeNotRun(name: GateName, at: string): GateResult {
  return {
    name,
    status: "not_run",
    startedAt: at,
    finishedAt: at,
    checks: [],
    evidence: {}
  };
}

/**
 * Build a `failed` evidence record from a load or validation error.
 */
export function synthesizeFailed(name: GateName, reason: string, at: string): GateResult {
  return {
    name,
    status: "failed",
    startedAt: at,
    finishedAt: at,
    checks: [],
    evidence: { failureReason: reason }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  claude: string | undefined;
  transcript: string | undefined;
  cloudflare: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { claude: undefined, transcript: undefined, cloudflare: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--claude") {
      out.claude = next;
      i++;
    } else if (a === "--transcript") {
      out.transcript = next;
      i++;
    } else if (a === "--cloudflare") {
      out.cloudflare = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function formatSummary(summary: GateSummary): string {
  const lines: string[] = [];
  lines.push("Phase 0 summary");
  lines.push(`  unlocked (${summary.unlocked.length}): ${summary.unlocked.join(", ") || "(none)"}`);
  lines.push(`  blocked  (${summary.blocked.length}): ${summary.blocked.join(", ") || "(none)"}`);
  lines.push("  gate verdicts:");
  for (const r of summary.results) {
    lines.push(`    ${r.name}: ${r.status}`);
  }
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const inputs: Array<{ gate: GateName; path: string | undefined }> = [
    { gate: "claude", path: args.claude },
    { gate: "transcript", path: args.transcript },
    { gate: "cloudflare", path: args.cloudflare }
  ];

  const loaded: GateResult[] = [];
  for (const { gate, path } of inputs) {
    if (!path) {
      const now = new Date().toISOString();
      loaded.push(synthesizeNotRun(gate, now));
      continue;
    }
    const resolved = resolve(path);
    const outcome = await loadEvidence(resolved);
    if (outcome.ok) {
      loaded.push(outcome.result);
    } else {
      const now = new Date().toISOString();
      loaded.push(synthesizeFailed(gate, outcome.reason, now));
    }
  }

  const summary = summarizeGates(loaded);

  const outPath = resolve("build/phase0/summary.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  process.stdout.write(formatSummary(summary) + "\n");
  return 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`phase0: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}

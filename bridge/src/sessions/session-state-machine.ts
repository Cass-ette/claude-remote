/**
 * Pure session state machine per spec §7.1, §7.5, §7.6.
 *
 * No DB access or I/O — the supervisor and snapshot writer both import
 * `assertTransition` to guard status writes.
 */

export const SESSION_STATUSES = [
  "inactive",
  "starting",
  "idle",
  "running",
  "waiting_permission",
  "interrupting",
  "releasing",
  "interrupted",
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** States the session never leaves on its own; only `failed` per §7.1. */
export const TERMINAL_SESSION_STATUSES = ["failed"] as const;
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

/**
 * Legal transitions.
 *
 * - §7.1 baseline lifecycle: inactive→starting, starting→idle|failed,
 *   idle→running|releasing|starting, running→idle|waiting_permission|interrupting|failed,
 *   waiting_permission→running|interrupting, interrupting→interrupted|failed,
 *   interrupted→releasing|starting, releasing→inactive.
 * - §7.6 crash recovery: running|waiting_permission|interrupting → interrupted
 *   when the Bridge restarts (running passes through interrupting first).
 * - `failed` has no outgoing transitions. `inactive` is only left by an
 *   explicit resume (→ starting). `idle → starting` covers resume of an
 *   idle session whose process has died: re-attaching a NEW process to a
 *   processless idle session is "awaiting system/init" — same semantics as
 *   `interrupted → starting`.
 */
const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  inactive: ["starting"],
  starting: ["idle", "failed"],
  idle: ["running", "releasing", "starting"],
  running: ["idle", "waiting_permission", "interrupting", "failed"],
  waiting_permission: ["running", "interrupting", "interrupted"],
  interrupting: ["interrupted", "failed"],
  releasing: ["inactive"],
  interrupted: ["releasing", "starting"],
  failed: [],
};

const STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUSES);

export class IllegalSessionTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal session state transition: ${from} -> ${to}`);
    this.name = "IllegalSessionTransitionError";
  }
}

function isSessionStatus(value: string): value is SessionStatus {
  return STATUS_SET.has(value);
}

export function canTransition(from: string, to: string): boolean {
  if (!isSessionStatus(from) || !isSessionStatus(to)) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalSessionTransitionError(from, to);
  }
}

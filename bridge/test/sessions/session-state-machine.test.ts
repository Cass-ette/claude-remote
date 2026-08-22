import { describe, expect, it } from "vitest";

import {
  IllegalSessionTransitionError,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  assertTransition,
  canTransition,
} from "../../src/sessions/session-state-machine.js";

const LEGAL: ReadonlySet<string> = new Set([
  "inactive:starting",
  "starting:idle",
  "starting:failed",
  "idle:running",
  "idle:releasing",
  "running:idle",
  "running:waiting_permission",
  "running:interrupting",
  "running:failed",
  "waiting_permission:running",
  "waiting_permission:interrupting",
  "waiting_permission:interrupted",
  "interrupting:interrupted",
  "interrupting:failed",
  "interrupted:releasing",
  "interrupted:starting",
  "releasing:inactive",
]);

describe("session state machine (§7.1, §7.5, §7.6)", () => {
  it("exposes the nine statuses from §7.1", () => {
    expect(SESSION_STATUSES).toEqual([
      "inactive",
      "starting",
      "idle",
      "running",
      "waiting_permission",
      "interrupting",
      "releasing",
      "interrupted",
      "failed",
    ]);
  });

  it("marks only failed as terminal (§7.1)", () => {
    expect(TERMINAL_SESSION_STATUSES).toEqual(["failed"]);
  });

  it("accepts exactly the legal transitions (exhaustive 9x9 matrix)", () => {
    for (const from of SESSION_STATUSES) {
      for (const to of SESSION_STATUSES) {
        const expected = LEGAL.has(`${from}:${to}`);
        expect(
          canTransition(from, to),
          `${from} -> ${to} should be ${expected ? "legal" : "illegal"}`,
        ).toBe(expected);
      }
    }
  });

  it("does not auto-leave failed (no outgoing transitions)", () => {
    for (const to of SESSION_STATUSES) {
      expect(canTransition("failed", to)).toBe(false);
    }
  });

  it("leaves inactive only via explicit resume to starting", () => {
    for (const to of SESSION_STATUSES) {
      expect(canTransition("inactive", to)).toBe(to === "starting");
    }
  });

  it("supports release only from idle or interrupted (§7.5)", () => {
    for (const from of SESSION_STATUSES) {
      expect(canTransition(from, "releasing")).toBe(
        from === "idle" || from === "interrupted",
      );
    }
  });

  it("supports crash recovery into interrupted (§7.6)", () => {
    expect(canTransition("running", "interrupted")).toBe(false); // via interrupting
    expect(canTransition("waiting_permission", "interrupted")).toBe(true);
    expect(canTransition("interrupting", "interrupted")).toBe(true);
  });

  it("assertTransition passes through for legal transitions", () => {
    expect(() => assertTransition("idle", "running")).not.toThrow();
  });

  it("assertTransition throws IllegalSessionTransitionError naming both states", () => {
    let err: unknown;
    try {
      assertTransition("failed", "idle");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IllegalSessionTransitionError);
    const message = (err as Error).message;
    expect(message).toContain("failed");
    expect(message).toContain("idle");
  });

  it("rejects unknown statuses", () => {
    expect(canTransition("paused", "idle")).toBe(false);
    // @ts-expect-error runtime guard against bad input
    expect(() => assertTransition("idle", "paused")).toThrow(
      IllegalSessionTransitionError,
    );
  });
});

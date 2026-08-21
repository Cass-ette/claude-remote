import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseEventId,
  validateCommand,
  validateEvent,
  validateResponse,
} from "../../../src/protocol/v1/validator.js";

const UUID = "019122ab-c100-7000-8000-000000000001";
const UUID2 = "019122ab-c100-7000-8000-000000000002";
const RFC3339_Z = "2026-08-02T12:00:00Z";
const RFC3339_OFFSET = "2026-08-02T12:00:00+08:00";

function command(
  commandType: string,
  payload: unknown,
  sessionId: string | null = null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: UUID,
    idempotencyKey: "idem-1",
    commandType,
    sessionId,
    sentAt: RFC3339_Z,
    payload,
    ...overrides,
  };
}

describe("validateCommand", () => {
  it("accepts every command payload variant", () => {
    const cases: Array<[string, unknown, string | null]> = [
      ["session.list", {}, null],
      ["session.scan_imports", { projectId: UUID2 }, null],
      ["session.import", { sessionId: UUID, projectId: UUID2 }, UUID],
      ["session.create", { projectId: UUID2 }, null],
      ["session.create", { projectId: UUID2, displayName: "chat" }, null],
      ["session.resume", { sessionId: UUID }, UUID],
      ["session.stop", { sessionId: UUID }, UUID],
      ["session.release", { sessionId: UUID }, UUID],
      ["session.state.get", { sessionId: UUID }, UUID],
      ["session.snapshot.begin", { sessionId: UUID }, UUID],
      ["session.snapshot.page", { sessionId: UUID, cursor: "abc" }, UUID],
      [
        "session.snapshot.commit",
        {
          sessionId: UUID,
          snapshotId: "snap-1",
          historyRevision: "rev-1",
          deliveryWatermark: "18446744073709551615",
          idempotencyKey: "idem-2",
        },
        UUID,
      ],
      ["message.send", { sessionId: UUID, text: "hello" }, UUID],
      ["command.cancel", { requestId: UUID2 }, null],
      ["command.retry_indeterminate", { requestId: UUID2 }, null],
      ["permission.resolve", { permissionRequestId: "perm-1", sessionId: UUID, decision: "deny" }, UUID],
      ["events.ack", { sessionId: UUID, lastEventId: "42" }, UUID],
    ];
    for (const [type, payload, sid] of cases) {
      const res = validateCommand(command(type, payload, sid));
      expect(res.ok, type).toBe(true);
    }
  });

  it("rejects unknown commandType", () => {
    expect(validateCommand(command("session.explode", {})).ok).toBe(false);
  });

  it("rejects wrong payload for a known commandType", () => {
    expect(validateCommand(command("session.resume", { projectId: UUID2 })).ok).toBe(false);
    expect(validateCommand(command("session.list", { extra: 1 })).ok).toBe(false);
    expect(validateCommand(command("message.send", { sessionId: UUID, text: "" })).ok).toBe(false);
    expect(
      validateCommand(command("events.ack", { sessionId: UUID, lastEventId: "0x10" })).ok,
    ).toBe(false);
  });

  it("rejects bad envelope fields", () => {
    expect(validateCommand(command("session.list", {}, null, { protocolVersion: "v2" })).ok).toBe(false);
    expect(validateCommand(command("session.list", {}, null, { requestId: "not-a-uuid" })).ok).toBe(false);
    expect(validateCommand(command("session.list", {}, null, { idempotencyKey: "" })).ok).toBe(false);
    expect(validateCommand(command("session.list", {}, "not-a-uuid")).ok).toBe(false);
    expect(validateCommand(command("session.list", {}, null, { extra: true })).ok).toBe(false);
  });

  it("accepts RFC3339 with Z or explicit offset, rejects others", () => {
    expect(validateCommand(command("session.list", {}, null, { sentAt: RFC3339_OFFSET })).ok).toBe(true);
    expect(validateCommand(command("session.list", {}, null, { sentAt: "2026-08-02 12:00:00" })).ok).toBe(
      false,
    );
    expect(validateCommand(command("session.list", {}, null, { sentAt: "not-a-date" })).ok).toBe(false);
  });

  it("rejects payloads over 256 KiB when serialized", () => {
    const big = { sessionId: UUID, text: "x".repeat(256 * 1024) };
    const res = validateCommand(command("message.send", big, UUID));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/256 KiB/);
  });

  it("accepts payloads at the 256 KiB boundary", () => {
    // Tune size so JSON.stringify(command) is just under 256 KiB.
    const envelopeOverhead =
      JSON.stringify(command("message.send", { sessionId: UUID, text: "" }, UUID)).length - 2;
    const big = { sessionId: UUID, text: "x".repeat(256 * 1024 - envelopeOverhead - 4) };
    expect(validateCommand(command("message.send", big, UUID)).ok).toBe(true);
  });
});

describe("validateEvent", () => {
  function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      eventId: "12345678901234567890",
      sessionId: UUID,
      eventType: "session.state.changed",
      timestamp: RFC3339_Z,
      payload: { state: "running" },
      ...overrides,
    };
  }

  it("accepts a valid event with 20-digit eventId", () => {
    expect(validateEvent(event()).ok).toBe(true);
  });

  it("rejects non-decimal eventId", () => {
    expect(validateEvent(event({ eventId: 42 })).ok).toBe(false);
    expect(validateEvent(event({ eventId: "0x10" })).ok).toBe(false);
    expect(validateEvent(event({ eventId: "12a" })).ok).toBe(false);
    expect(validateEvent(event({ eventId: "-5" })).ok).toBe(false);
  });

  it("rejects eventId over 20 digits", () => {
    expect(validateEvent(event({ eventId: "123456789012345678901" })).ok).toBe(false);
  });

  it("rejects unknown eventType and bad envelope", () => {
    expect(validateEvent(event({ eventType: "magic.happened" })).ok).toBe(false);
    expect(validateEvent(event({ timestamp: "nope" })).ok).toBe(false);
    expect(validateEvent(event({ protocolVersion: "v9" })).ok).toBe(false);
  });

  it("validates command.status.changed payload shape", () => {
    const good = {
      requestId: UUID2,
      idempotencyKey: "idem-1",
      commandType: "session.resume",
      commandStatus: "dispatched",
    };
    expect(validateEvent(event({ eventType: "command.status.changed", payload: good })).ok).toBe(true);
    expect(
      validateEvent(event({ eventType: "command.status.changed", payload: { ...good, commandStatus: "weird" } }))
        .ok,
    ).toBe(false);
    expect(
      validateEvent(event({ eventType: "command.status.changed", payload: { requestId: UUID2 } })).ok,
    ).toBe(false);
  });
});

describe("validateResponse", () => {
  it("accepts command.status with a valid commandStatus and result", () => {
    expect(
      validateResponse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: UUID,
        responseType: "command.status",
        commandStatus: "accepted",
        result: { queued: true },
      }).ok,
    ).toBe(true);
  });

  it("rejects command.status without commandStatus or with invalid state", () => {
    expect(
      validateResponse({ protocolVersion: PROTOCOL_VERSION, requestId: UUID, responseType: "command.status" }).ok,
    ).toBe(false);
    expect(
      validateResponse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: UUID,
        responseType: "command.status",
        commandStatus: "exploded",
      }).ok,
    ).toBe(false);
  });

  it("accepts command.error with error object, rejects without", () => {
    const err = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: UUID,
      responseType: "command.error",
      error: { code: "E_BAD", message: "bad", retryable: false },
    };
    expect(validateResponse(err).ok).toBe(true);
    const { error: _omit, ...withoutError } = err;
    expect(validateResponse(withoutError).ok).toBe(false);
  });

  it("rejects unknown responseType", () => {
    expect(
      validateResponse({ protocolVersion: PROTOCOL_VERSION, requestId: UUID, responseType: "magic" }).ok,
    ).toBe(false);
  });
});

describe("parseEventId", () => {
  it("parses decimal strings to bigint", () => {
    expect(parseEventId("0")).toBe(0n);
    expect(parseEventId("18446744073709551615")).toBe(18446744073709551615n);
  });

  it("throws on non-decimal input", () => {
    expect(() => parseEventId("0x10")).toThrow();
    expect(() => parseEventId("1.5")).toThrow();
    expect(() => parseEventId("")).toThrow();
    expect(() => parseEventId("99999999999999999999")).toThrow(); // > uint64
  });
});

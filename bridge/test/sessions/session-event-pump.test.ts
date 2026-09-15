import { describe, expect, it, vi } from "vitest";
import { createSessionEventPump } from "../../src/sessions/session-event-pump.js";
import type { ClaudeProcessHandle } from "../../src/sessions/session-supervisor.js";

function fakeHandle(events: unknown[]): ClaudeProcessHandle {
  return {
    sessionId: "s1",
    pid: 123,
    sendUser() {},
    closeInput() {},
    signal() {},
    alive: () => true,
    awaitInit: () => Promise.resolve({ session_id: "s1" }),
    events: async function* () {
      for (const event of events) yield event as never;
    },
  };
}

/** A replayed tool-result `user` record, as `--replay-user-messages` emits it. */
function toolResultEcho(uuid: string) {
  return {
    type: "user",
    uuid,
    session_id: "s1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    parent_tool_use_id: null,
  };
}

function textUserEcho(uuid: string) {
  return {
    type: "user",
    uuid,
    session_id: "s1",
    message: { role: "user", content: [{ type: "text", text: "run it" }] },
    parent_tool_use_id: null,
  };
}

function assistantRecord(uuid: string) {
  return { type: "assistant", uuid, message: { role: "assistant", content: [] } };
}

function resultRecord(overrides: Record<string, unknown> = {}) {
  return { type: "result", subtype: "success", is_error: false, result: "done", duration_ms: 5, ...overrides };
}

describe("session event pump", () => {
  it("journals assistant records and completes the turn on result", async () => {
    const appended: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const completions: Array<{ sessionId: string; outcome: string; result: unknown }> = [];
    const pump = createSessionEventPump({
      appendEvent: (_sessionId, eventType, payload) => {
        appended.push({ eventType, payload });
      },
      completeMessage: async (input) => {
        completions.push({ sessionId: input.sessionId, outcome: input.outcome, result: input.result });
      },
    });
    pump.track(
      "s1",
      fakeHandle([
        textUserEcho("req-1"),
        assistantRecord("m-1"),
        { type: "stream_event", event: { type: "content_block_delta" } },
        resultRecord(),
      ]),
    );
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toEqual({
      sessionId: "s1",
      outcome: "completed",
      result: { result: "done", durationMs: 5, totalCostUsd: null },
    });
    expect(appended.map((a) => a.eventType)).toEqual([
      "assistant.message.completed",
      "assistant.message.delta",
    ]);
  });

  it("maps is_error results to outcome failed", async () => {
    const completions: Array<{ outcome: string }> = [];
    const pump = createSessionEventPump({
      appendEvent: () => {},
      completeMessage: async (input) => {
        completions.push({ outcome: input.outcome });
      },
    });
    pump.track("s1", fakeHandle([textUserEcho("req-1"), resultRecord({ is_error: true })]));
    await vi.waitFor(() => expect(completions).toEqual([{ outcome: "failed" }]));
  });

  it("ignores foreign user-record uuids entirely (CLI-echoed tool results / unknown ids never wedge the turn)", async () => {
    const completions: Array<{ sessionId: string }> = [];
    const errors: unknown[] = [];
    const pump = createSessionEventPump({
      appendEvent: () => {},
      completeMessage: async (input) => {
        completions.push({ sessionId: input.sessionId });
      },
      onError: (_sessionId, error) => errors.push(error),
    });
    pump.track(
      "s1",
      fakeHandle([
        textUserEcho("req-1"),
        assistantRecord("m-1"), // e.g. a tool_use assistant message
        toolResultEcho("toolres-1"), // CLI-generated uuid — NOT a command requestId
        assistantRecord("m-2"),
        toolResultEcho("toolres-2"),
        // a CLI-internal turn echo with an unknown uuid the bridge never wrote
        textUserEcho("95e16169-c578-4105-b39c-a2f5725170ff"),
        assistantRecord("m-3"),
        resultRecord(),
      ]),
    );
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]?.sessionId).toBe("s1");
    expect(errors).toEqual([]);
  });

  it("completes each turn on its own result", async () => {
    const completions: unknown[] = [];
    const pump = createSessionEventPump({
      appendEvent: () => {},
      completeMessage: async () => {
        completions.push({});
      },
    });
    pump.track(
      "s1",
      fakeHandle([
        textUserEcho("req-1"),
        resultRecord(),
        toolResultEcho("toolres-3"),
        textUserEcho("req-2"),
        assistantRecord("m-2"),
        resultRecord(),
      ]),
    );
    await vi.waitFor(() => expect(completions).toHaveLength(2));
  });
});

/**
 * Session event pump (Task 24 wiring).
 *
 * Consumes the classified stream-json stdout events of every locally started
 * Claude process (via the supervisor's onProcessStarted hook) and:
 *
 *   * journals `assistant.message.delta` for `stream_event` frames and
 *     `assistant.message.completed` for each top-level `assistant` record;
 *   * completes the session's dispatched turn on `result` records
 *     (supervisor.completeMessage: dispatched → completed/failed WITH a
 *     command.status.changed event, then running → idle).
 *
 * The requestId is resolved by the supervisor from its dispatch-time record —
 * the pump deliberately does NOT bind it from stdout `user` echoes. The CLI
 * also echoes records the bridge never wrote (tool results, CLI-internal
 * turns) with CLI-generated uuids; binding those used to wedge turns at
 * completion (completeMessage → unknown requestId killed the pump).
 *
 * The pump never blocks the supervisor: iteration runs detached and every
 * failure is reported through `onError` only. Events arriving before the
 * pump subscribes are buffered by the adapter's events() iterator, so a
 * subscription made at process start never misses a turn.
 */
import type { ClaudeStreamEvent } from "../claude/stream-json-adapter.js";
import type { ClaudeProcessHandle } from "./session-supervisor.js";

export interface SessionEventPumpDeps {
  /** Journaled append (category "system"); runtime routes it through the resync mutex. */
  readonly appendEvent: (sessionId: string, eventType: string, payload: Record<string, unknown>) => unknown;
  readonly completeMessage: (input: {
    sessionId: string;
    outcome: "completed" | "failed";
    result?: unknown;
  }) => Promise<void>;
  /** Failure sink (logging); pump errors never propagate. */
  readonly onError?: (sessionId: string, error: unknown) => void;
}

export interface SessionEventPump {
  /** Begin consuming a process's events; at most once per handle. */
  track(sessionId: string, handle: ClaudeProcessHandle): void;
}

export function createSessionEventPump(deps: SessionEventPumpDeps): SessionEventPump {
  const tracked = new WeakSet<ClaudeProcessHandle>();

  return {
    track(sessionId, handle) {
      if (handle.events === undefined || tracked.has(handle)) return;
      tracked.add(handle);

      void (async () => {
        try {
          for await (const event of handle.events!()) {
            const type = (event as { type?: unknown }).type;
            if (type === "assistant") {
              const uuid = (event as { uuid?: unknown }).uuid;
              deps.appendEvent(sessionId, "assistant.message.completed", {
                messageUuid: typeof uuid === "string" ? uuid : null,
                message: (event as { message?: unknown }).message ?? null,
              });
            } else if (type === "stream_event") {
              deps.appendEvent(sessionId, "assistant.message.delta", {
                frame: (event as Record<string, unknown>).event ?? null,
              });
            } else if (type === "result") {
              await deps.completeMessage({
                sessionId,
                outcome: (event as { is_error?: unknown }).is_error === true ? "failed" : "completed",
                result: {
                  result: (event as Record<string, unknown>).result ?? null,
                  durationMs: (event as Record<string, unknown>).duration_ms ?? null,
                  totalCostUsd: (event as Record<string, unknown>).total_cost_usd ?? null,
                },
              });
            }
          }
        } catch (error) {
          deps.onError?.(sessionId, error);
        }
      })();
    },
  };
}

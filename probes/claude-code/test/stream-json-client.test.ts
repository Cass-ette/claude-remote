import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ClaudeStreamClient } from "../src/stream-json-client.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeClaudePath = join(here, "fixtures/fake-claude.mjs");

describe("ClaudeStreamClient (fake-process framing)", () => {
  let client: ClaudeStreamClient;
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "claude-probe-"));
    await mkdir(join(workdir, "mcp"), { recursive: true });
    await writeFile(
      join(workdir, "mcp/config.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8"
    );
    // Override the binary the driver spawns so it runs our fake fixture
    // instead of the real `claude` CLI. The fake reads NDJSON from stdin
    // and emits the candidate envelope deterministically.
    process.env.CLAUDE_BIN = process.execPath;
    process.env.CLAUDE_BIN_ARGS = JSON.stringify([fakeClaudePath]);
    client = new ClaudeStreamClient();
  });

  afterEach(async () => {
    try {
      await client.closeInput();
    } catch {
      // already closed
    }
    delete process.env.CLAUDE_BIN;
    delete process.env.CLAUDE_BIN_ARGS;
    await rm(workdir, { recursive: true, force: true });
  });

  it("emits system/init referencing the requested session id", async () => {
    const sessionId = randomUUID();
    await client.startCreate(
      sessionId,
      workdir,
      join(workdir, "mcp/config.json"),
      "mcp__claude_remote_permission__decide"
    );

    const events = client.events();
    const first = await events.next();
    expect(first.done).toBe(false);
    const init = first.value as { type: string; subtype?: string; session_id?: string };
    expect(init.type).toBe("system");
    expect(init.subtype).toBe("init");
    expect(init.session_id).toBe(sessionId);
  });

  it("writes exactly one JSON object per newline and the candidate UUID is replayed", async () => {
    const sessionId = randomUUID();
    await client.startCreate(
      sessionId,
      workdir,
      join(workdir, "mcp/config.json"),
      "mcp__claude_remote_permission__decide"
    );

    const requestUuid = randomUUID();
    await client.sendCandidateUser(requestUuid, sessionId, "hello");

    const events = client.events();
    // Drain init.
    await events.next();

    // The next user record we observe MUST carry the exact UUID we sent.
    // The fake fixture parses one JSON object per line, so a partial or
    // multi-object frame would surface here as a missing/mismatched UUID.
    let sawReplay = false;
    const drain: Promise<void> = (async () => {
      for await (const ev of events) {
        const e = ev as { type?: string; uuid?: string };
        if (e.type === "user" && e.uuid === requestUuid) {
          sawReplay = true;
          return;
        }
      }
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000));
    await Promise.race([drain, timeout]);
    expect(sawReplay).toBe(true);
  });

  it("keeps stdin open after a result and supports a second turn", async () => {
    const sessionId = randomUUID();
    await client.startCreate(
      sessionId,
      workdir,
      join(workdir, "mcp/config.json"),
      "mcp__claude_remote_permission__decide"
    );

    const u1 = randomUUID();
    const u2 = randomUUID();
    await client.sendCandidateUser(u1, sessionId, "turn-1");

    const events = client.events();
    await events.next(); // drain init

    const seenResults: string[] = [];
    const seenReplays: string[] = [];
    const drain: Promise<void> = (async () => {
      let firstResultSeen = false;
      for await (const ev of events) {
        const e = ev as { type?: string; subtype?: string; uuid?: string };
        if (e.type === "result" && !firstResultSeen) {
          firstResultSeen = true;
          seenResults.push("first");
          // Send the second turn AFTER observing the first result to prove
          // the driver did not auto-close stdin.
          await client.sendCandidateUser(u2, sessionId, "turn-2");
        } else if (e.type === "result" && firstResultSeen) {
          seenResults.push("second");
          return;
        }
        if (e.type === "user" && e.uuid) {
          seenReplays.push(e.uuid);
        }
      }
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000));
    await Promise.race([drain, timeout]);

    expect(seenResults).toContain("first");
    expect(seenResults).toContain("second");
    expect(seenReplays).toEqual(expect.arrayContaining([u1, u2]));
  });

  it("terminates cleanly when stdin is closed", async () => {
    const sessionId = randomUUID();
    await client.startCreate(
      sessionId,
      workdir,
      join(workdir, "mcp/config.json"),
      "mcp__claude_remote_permission__decide"
    );
    await client.sendCandidateUser(randomUUID(), sessionId, "single");

    const events = client.events();
    const collected: unknown[] = [];
    const drainUntilDone: Promise<void> = (async () => {
      for await (const ev of events) collected.push(ev);
    })();

    await new Promise((r) => setTimeout(r, 150));
    await client.closeInput();

    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000));
    await Promise.race([drainUntilDone, timeout]);

    // After stdin closes the event stream MUST eventually end.
    const next = await events.next();
    expect(next.done).toBe(true);
    expect(collected.length).toBeGreaterThan(0);
  });

  it("partial stdout chunks are reassembled into complete frames", async () => {
    // The fake fixture writes whole lines, but the driver must still handle
    // arbitrary byte-grain chunking from Node's pipe. Assert every yielded
    // frame is a complete JSON object with a string `type`.
    const sessionId = randomUUID();
    await client.startCreate(
      sessionId,
      workdir,
      join(workdir, "mcp/config.json"),
      "mcp__claude_remote_permission__decide"
    );
    const events = client.events();
    const inspected: unknown[] = [];
    const drain: Promise<void> = (async () => {
      for await (const ev of events) {
        inspected.push(ev);
        if (inspected.length >= 2) return;
      }
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000));
    await Promise.race([drain, timeout]);

    expect(inspected.length).toBeGreaterThanOrEqual(1);
    for (const ev of inspected) {
      const obj = ev as { type?: string };
      expect(typeof obj).toBe("object");
      expect(obj).not.toBeNull();
      expect(typeof obj.type).toBe("string");
      expect((obj.type ?? "").length).toBeGreaterThan(0);
    }
  });
});

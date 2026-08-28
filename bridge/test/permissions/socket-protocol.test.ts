/**
 * Frame codec tests (Task 17, socket-protocol.ts).
 *
 * The broker tests exercise the codec end-to-end through TestAdapter, but
 * both sides then share the PRODUCTION encoder/decoder, so a compensating
 * bug (e.g. a wrong length prefix written and tolerated by the reader)
 * would cancel out. These tests pin the wire format from raw bytes and
 * cover the decoder's buffering directly: split frames, coalesced frames
 * and the oversize guard.
 */
import { describe, expect, it } from "vitest";
import {
  createFrameDecoder,
  encodeFrame,
  FrameProtocolError,
  MAX_FRAME_BYTES,
} from "../../src/permissions/socket-protocol.js";

/** Hand-build the wire format: 4-byte big-endian length + UTF-8 JSON body. */
function rawFrame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

describe("socket frame codec", () => {
  it("reassembles one frame fed in 1-3 byte chunks", () => {
    const decoder = createFrameDecoder();
    const frame = {
      type: "permission_request",
      toolName: "Bash",
      input: { command: "ls -la /tmp", nested: { a: [1, 2, { deep: true }] } },
    };
    const bytes = encodeFrame(frame);

    const values: unknown[] = [];
    let offset = 0;
    let chunkSize = 1;
    while (offset < bytes.length) {
      values.push(...decoder.push(bytes.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
      // Cycle 1→2→3: every prefix length hits the "not enough bytes yet"
      // branches (header incomplete, body incomplete).
      chunkSize = chunkSize === 3 ? 1 : chunkSize + 1;
    }
    expect(values).toEqual([frame]);
    // Nothing more is buffered.
    expect(decoder.push(Buffer.alloc(0))).toEqual([]);
  });

  it("decodes a hand-built length-prefixed frame exactly as encoded", () => {
    const decoder = createFrameDecoder();
    const json = '{"type":"hello","leaseSecret":"s","sessionId":"u"}';
    const raw = rawFrame(json);
    expect(decoder.push(raw)).toEqual([{ type: "hello", leaseSecret: "s", sessionId: "u" }]);
    // ...and the production encoder produces the identical wire bytes.
    expect(raw.equals(encodeFrame({ type: "hello", leaseSecret: "s", sessionId: "u" }))).toBe(
      true,
    );
  });

  it("decodes two frames coalesced into a single chunk, in order", () => {
    const decoder = createFrameDecoder();
    const first = { type: "request_registered", permissionRequestId: "p1" };
    const second = {
      type: "decision",
      permissionRequestId: "p1",
      behavior: "deny",
      message: "no",
      interrupt: false,
    };
    const values = decoder.push(Buffer.concat([encodeFrame(first), encodeFrame(second)]));
    expect(values).toEqual([first, second]);
  });

  it("rejects an over-cap length prefix and non-JSON bodies", () => {
    const oversize = Buffer.alloc(4);
    oversize.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => createFrameDecoder().push(oversize)).toThrow(FrameProtocolError);

    const garbage = rawFrame("not{(");
    expect(() => createFrameDecoder().push(garbage)).toThrow(FrameProtocolError);
  });
});

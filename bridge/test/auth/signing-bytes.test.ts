/**
 * Canonical signing-bytes and host-normalization tests (spec §10.3).
 *
 * The committed cross-implementation fixture
 * (contracts/v1/auth-signing-fixture.json) pins the exact byte layout; the
 * tests below compare the implementation output against the fixture hex AND
 * against an independently hand-constructed buffer, so a systematic bug in
 * the implementation cannot be masked by a fixture generated through the same
 * code path.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidHostException,
  SIGNING_CONTEXT,
  SigningInputError,
  buildSigningBytes,
  normalizeHost,
} from "../../src/auth/signing-bytes.js";

const fixturePath = join(import.meta.dirname, "..", "..", "..", "contracts", "v1", "auth-signing-fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  hostUrl: string;
  hostAscii: string;
  accessSubject: string;
  publicKeySpkiB64u: string;
  deviceId: string;
  challengeId: string;
  challengeRawHex: string;
  signingContentHex: string;
  signatureDerB64u: string;
};

describe("normalizeHost", () => {
  it("lowercases, strips the FQDN trailing dot, and drops the default :443 port", () => {
    expect(normalizeHost("https://Bridge.Example.COM./")).toBe("bridge.example.com");
    expect(normalizeHost("https://example.com:443/")).toBe("example.com");
    expect(normalizeHost("https://example.com")).toBe("example.com");
  });

  it("performs IDNA ToASCII on Unicode hostnames", () => {
    expect(normalizeHost("https://例え.jp/")).toBe("xn--r8jz45g.jp");
  });

  it("accepts a bare canonical hostname (already-normalized storage form)", () => {
    expect(normalizeHost("bridge.example.com")).toBe("bridge.example.com");
  });

  it("rejects non-https schemes", () => {
    expect(() => normalizeHost("http://example.com/")).toThrow(InvalidHostException);
    expect(() => normalizeHost("ws://example.com/")).toThrow(InvalidHostException);
    expect(() => normalizeHost("example.com:8443")).toThrow(InvalidHostException); // parsed as a bogus scheme
  });

  it("rejects userinfo", () => {
    expect(() => normalizeHost("https://user:pass@example.com/")).toThrow(InvalidHostException);
    expect(() => normalizeHost("https://user@example.com/")).toThrow(InvalidHostException);
  });

  it("rejects query strings and fragments", () => {
    expect(() => normalizeHost("https://example.com/?q=1")).toThrow(InvalidHostException);
    expect(() => normalizeHost("https://example.com/#section")).toThrow(InvalidHostException);
  });

  it("rejects a non-empty path other than /", () => {
    expect(() => normalizeHost("https://example.com/app")).toThrow(InvalidHostException);
    expect(() => normalizeHost("https://example.com/app/")).toThrow(InvalidHostException);
  });

  it("rejects ports other than empty/443", () => {
    expect(() => normalizeHost("https://example.com:8443/")).toThrow(InvalidHostException);
    expect(() => normalizeHost("https://example.com:80/")).toThrow(InvalidHostException);
  });

  it("rejects empty, whitespace-only, and structurally invalid hosts", () => {
    expect(() => normalizeHost("")).toThrow(InvalidHostException);
    expect(() => normalizeHost("   ")).toThrow(InvalidHostException);
    expect(() => normalizeHost("https://..../")).toThrow(InvalidHostException); // empty labels
    expect(() => normalizeHost("a..b")).toThrow(InvalidHostException); // domainToASCII passes this through
    expect(() => normalizeHost("https://example.com../")).toThrow(InvalidHostException); // double trailing dot
    expect(() => normalizeHost("https://[2606:4700::6810:85e5]/")).toThrow(InvalidHostException); // IPv6 literal
    expect(() => normalizeHost("/just/a/path")).toThrow(InvalidHostException);
  });
});

describe("buildSigningBytes", () => {
  it("equals the committed cross-implementation fixture byte-for-byte", () => {
    const bytes = buildSigningBytes({
      hostAscii: fixture.hostAscii,
      deviceId: fixture.deviceId,
      challengeId: fixture.challengeId,
      accessSubject: fixture.accessSubject,
      challengeRaw: Buffer.from(fixture.challengeRawHex, "hex"),
    });
    expect(bytes.equals(Buffer.from(fixture.signingContentHex, "hex"))).toBe(true);
  });

  it("matches an independently hand-constructed buffer", () => {
    const hostBytes = Buffer.from(fixture.hostAscii, "utf8");
    const deviceBytes = Buffer.from(fixture.deviceId, "ascii");
    const challengeIdBytes = Buffer.from(fixture.challengeId, "ascii");
    const subjectBytes = Buffer.from(fixture.accessSubject, "utf8");
    const challengeRaw = Buffer.from(fixture.challengeRawHex, "hex");

    const u16 = (v: number) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(v);
      return b;
    };
    const u32 = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(v);
      return b;
    };
    const expected = Buffer.concat([
      Buffer.from(SIGNING_CONTEXT, "ascii"),
      Buffer.from([0x00]),
      u16(hostBytes.length),
      hostBytes,
      u16(deviceBytes.length),
      deviceBytes,
      u16(challengeIdBytes.length),
      challengeIdBytes,
      u32(subjectBytes.length),
      subjectBytes,
      challengeRaw,
    ]);

    const bytes = buildSigningBytes({
      hostAscii: fixture.hostAscii,
      deviceId: fixture.deviceId,
      challengeId: fixture.challengeId,
      accessSubject: fixture.accessSubject,
      challengeRaw,
    });
    expect(bytes.equals(expected)).toBe(true);
  });

  it("encodes non-ASCII accessSubject as raw UTF-8 without normalization", () => {
    // Precomposed ü plus a combining dot: NFC folding must NOT occur, and
    // the length prefix counts UTF-8 BYTES, not UTF-16 code units.
    const subject = "ü̇ser";
    const subjectBytes = Buffer.from(subject, "utf8");
    const bytes = buildSigningBytes({
      hostAscii: "bridge.example.com",
      deviceId: "d",
      challengeId: "c",
      accessSubject: subject,
      challengeRaw: Buffer.alloc(32, 0xab),
    });
    // The u32be length prefix sits immediately before the subject bytes,
    // which sit immediately before the 32-byte challengeRaw.
    const prefixStart = bytes.length - 32 - subjectBytes.length - 4;
    expect(bytes.readUInt32BE(prefixStart)).toBe(subjectBytes.length);
    expect(bytes.subarray(prefixStart + 4, bytes.length - 32).equals(subjectBytes)).toBe(true);
    expect(bytes.subarray(bytes.length - 32).equals(Buffer.alloc(32, 0xab))).toBe(true);
  });

  it("rejects challengeRaw that is not exactly 32 bytes", () => {
    const input = {
      hostAscii: "bridge.example.com",
      deviceId: "dev",
      challengeId: "chal",
      accessSubject: "user@example.com",
    };
    expect(() => buildSigningBytes({ ...input, challengeRaw: Buffer.alloc(31) })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...input, challengeRaw: Buffer.alloc(33) })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...input, challengeRaw: Buffer.alloc(0) })).toThrow(SigningInputError);
  });

  it("rejects empty and non-ASCII fields", () => {
    const challengeRaw = Buffer.alloc(32);
    const base = { hostAscii: "bridge.example.com", deviceId: "dev", challengeId: "chal", accessSubject: "s" };
    expect(() => buildSigningBytes({ ...base, hostAscii: "", challengeRaw })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...base, deviceId: "", challengeRaw })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...base, challengeId: "", challengeRaw })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...base, accessSubject: "", challengeRaw })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...base, deviceId: "düv", challengeRaw })).toThrow(SigningInputError);
    expect(() => buildSigningBytes({ ...base, challengeId: "cål", challengeRaw })).toThrow(SigningInputError);
  });

  it("rejects a host whose UTF-8 length does not fit u16", () => {
    const bytes = buildSigningBytes({
      hostAscii: "a".repeat(0xffff),
      deviceId: "dev",
      challengeId: "chal",
      accessSubject: "s",
      challengeRaw: Buffer.alloc(32),
    });
    expect(bytes.subarray(SIGNING_CONTEXT.length + 1, SIGNING_CONTEXT.length + 3).readUInt16BE(0)).toBe(0xffff);
    expect(() =>
      buildSigningBytes({
        hostAscii: "a".repeat(0x10000),
        deviceId: "dev",
        challengeId: "chal",
        accessSubject: "s",
        challengeRaw: Buffer.alloc(32),
      }),
    ).toThrow(SigningInputError);
  });
});

describe("fixture cross-checks", () => {
  it("fixture deviceId is base64url_no_pad(SHA-256(SPKI DER))", () => {
    const spki = Buffer.from(fixture.publicKeySpkiB64u, "base64url");
    const expected = createHash("sha256").update(spki).digest().toString("base64url");
    expect(fixture.deviceId).toBe(expected);
  });

  it("fixture signature verifies over the implementation-built bytes", () => {
    const key = createPublicKey({
      key: Buffer.from(fixture.publicKeySpkiB64u, "base64url"),
      format: "der",
      type: "spki",
    });
    const bytes = buildSigningBytes({
      hostAscii: fixture.hostAscii,
      deviceId: fixture.deviceId,
      challengeId: fixture.challengeId,
      accessSubject: fixture.accessSubject,
      challengeRaw: Buffer.from(fixture.challengeRawHex, "hex"),
    });
    expect(verify("sha256", bytes, key, Buffer.from(fixture.signatureDerB64u, "base64url"))).toBe(true);
  });
});

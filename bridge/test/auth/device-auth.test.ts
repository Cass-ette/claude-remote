/**
 * Device pairing, challenge, session, and revocation lifecycle tests
 * (spec §10.3, §10.4).
 *
 * Real P-256 keypairs are generated at test time; signatures are produced with
 * Node crypto over the canonical signing bytes from src/auth/signing-byts.ts.
 * Each test group runs against a fresh SQLite database for full isolation.
 */
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { buildSigningBytes } from "../../src/auth/signing-bytes.js";
import {
  CHALLENGE_TTL_SECONDS,
  DEFAULT_DEVICE_SESSION_TTL_SECONDS,
  PAIRING_TOKEN_TTL_SECONDS,
  ChallengeError,
  DeviceAuthError,
  DeviceIdMismatchError,
  DeviceRevokedError,
  InvalidPublicKeyError,
  PairingTokenError,
  SignatureError,
  SinglePairedDeviceError,
  SubjectMismatchError,
  UnknownDeviceError,
  createDeviceAuth,
  deviceIdFromSpki,
} from "../../src/auth/device-auth.js";

const HOST = "bridge.example.com";
const SUBJECT = "user@example.com";
const OTHER_SUBJECT = "attacker@evil.example";
const T0 = 1_700_000_000_000;

/** P-256 prime field modulus (for the off-curve mutation). */
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
/** P-256 group order (for crafting out-of-range signature integers). */
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64U_32BYTES = /^[A-Za-z0-9_-]{43}$/;

const tempRoot = mkdtempSync(join(tmpdir(), "device-auth-test-"));
let dbCounter = 0;
const openDbs: SqliteDatabase[] = [];

afterAll(() => {
  for (const db of openDbs) db.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Fresh, fully migrated database + DeviceAuth registry per test group. */
function freshAuth(ttlSeconds?: number): { auth: ReturnType<typeof createDeviceAuth>; db: SqliteDatabase } {
  const db = openDatabase(join(tempRoot, `t${dbCounter++}.db`), { createDir: false });
  openDbs.push(db);
  migrate(db);
  return {
    auth: createDeviceAuth(db, ttlSeconds === undefined ? undefined : { deviceSessionTtlSeconds: ttlSeconds }),
    db,
  };
}

interface DeviceKeys {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly spki: Buffer;
  readonly deviceId: string;
}

function newDeviceKeys(curve = "P-256"): DeviceKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKey, spki, deviceId: deviceIdFromSpki(spki) };
}

function pairDevice(
  auth: ReturnType<typeof createDeviceAuth>,
  keys: DeviceKeys,
  options: { accessSubject?: string; displayName?: string; now?: number } = {},
): { deviceId: string; token: string } {
  const now = options.now ?? T0;
  const { token } = auth.mintPairingToken(now);
  const { deviceId } = auth.pairWithToken({
    pairingToken: token,
    publicKeySpkiB64u: keys.spki.toString("base64url"),
    deviceId: keys.deviceId,
    accessSubject: options.accessSubject ?? SUBJECT,
    displayName: options.displayName ?? "Pixel 9",
    now,
  });
  return { deviceId, token };
}

/** Run the full challenge → sign → verify flow and return every intermediate. */
function completeChallenge(
  auth: ReturnType<typeof createDeviceAuth>,
  keys: DeviceKeys,
  options: {
    deviceId?: string;
    accessSubject?: string;
    echoSubject?: string;
    currentSubject?: string;
    now?: number;
    corrupt?: (content: Buffer) => Buffer;
  } = {},
) {
  const now = options.now ?? T0;
  const deviceId = options.deviceId ?? keys.deviceId;
  const accessSubject = options.accessSubject ?? SUBJECT;
  const challenge = auth.issueChallenge({ deviceId, accessSubject, hostAscii: HOST, now });
  const challengeRaw = Buffer.from(challenge.challengeRawB64u, "base64url");
  let content = buildSigningBytes({
    hostAscii: HOST,
    deviceId,
    challengeId: challenge.challengeId,
    accessSubject: challenge.accessSubject,
    challengeRaw,
  });
  if (options.corrupt) content = options.corrupt(content);
  const signatureDer = sign("sha256", content, { key: keys.privateKey, dsaEncoding: "der" });
  const session = auth.verifyDeviceSignature({
    challengeId: challenge.challengeId,
    accessSubjectEcho: options.echoSubject ?? challenge.accessSubject,
    signatureB64u: signatureDer.toString("base64url"),
    currentAccessSubject: options.currentSubject ?? accessSubject,
    now,
  });
  return { deviceId, challenge, challengeRaw, signatureDer, session };
}

// --- DER crafting helpers for signature-malleability tests -------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

/** Raw INTEGER from exact bytes (no minimality enforcement). */
function derIntBytes(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

/** Minimally-encoded positive INTEGER from a BigInt. */
function derIntBig(v: bigint): Buffer {
  if (v <= 0n) throw new Error("test helper expects a positive integer");
  let hex = v.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let body = Buffer.from(hex, "hex");
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
  return derIntBytes(body);
}

function derSeq(...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
}

/** A random valid (r, s) pair under n, for crafting structurally valid DER. */
function randomScalarBelowN(): bigint {
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return (BigInt(`0x${hex}`) % (P256_N - 2n)) + 1n;
}

/** Valid P-256 SPKI whose point is off the curve (y incremented by one). */
function offCurveSpki(keys: DeviceKeys): Buffer {
  const mutated = Buffer.from(keys.spki);
  const y = BigInt(`0x${keys.spki.subarray(keys.spki.length - 32).toString("hex")}`);
  const yPlusOne = (y + 1n) % P256_P;
  mutated.set(Buffer.from(yPlusOne.toString(16).padStart(64, "0"), "hex"), mutated.length - 32);
  return mutated;
}

// -----------------------------------------------------------------------------
// 1. Pairing token: hashed storage, atomic consumption, replay/expiry/unknown
// -----------------------------------------------------------------------------

describe("pairing tokens", () => {
  it("mints a 256-bit single-use token stored only as its SHA-256 hash with a 5-minute expiry", () => {
    const { auth, db } = freshAuth();
    const { token, expiresAt } = auth.mintPairingToken(T0);
    expect(token).toMatch(B64U_32BYTES);
    expect(Buffer.from(token, "base64url").length).toBe(32);
    expect(expiresAt).toBe(T0 + PAIRING_TOKEN_TTL_SECONDS * 1000);

    const rows = db.prepare("SELECT tokenHash, expiresAt, consumedAt FROM pairing_tokens").all() as Array<{
      tokenHash: string;
      expiresAt: number;
      consumedAt: number | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.consumedAt).toBeNull();
    expect(rows[0]!.expiresAt).toBe(expiresAt);
  });

  it("consumes the pairing token atomically and rejects replay", () => {
    const { auth, db } = freshAuth();
    const keys = newDeviceKeys();
    const { token } = auth.mintPairingToken(T0);
    const input = {
      pairingToken: token,
      publicKeySpkiB64u: keys.spki.toString("base64url"),
      deviceId: keys.deviceId,
      accessSubject: SUBJECT,
      displayName: "Pixel 9",
      now: T0,
    };
    expect(auth.pairWithToken(input).deviceId).toBe(keys.deviceId);

    expect(() => auth.pairWithToken(input)).toThrow(PairingTokenError);
    const row = db.prepare("SELECT consumedAt FROM pairing_tokens").get() as { consumedAt: number | null };
    expect(row.consumedAt).toBe(T0);
  });

  it("rejects an expired pairing token", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const { token } = auth.mintPairingToken(T0);
    expect(() =>
      auth.pairWithToken({
        pairingToken: token,
        publicKeySpkiB64u: keys.spki.toString("base64url"),
        deviceId: keys.deviceId,
        accessSubject: SUBJECT,
        now: T0 + PAIRING_TOKEN_TTL_SECONDS * 1000 + 1,
      }),
    ).toThrow(PairingTokenError);
  });

  it("rejects an unknown pairing token without leaking which check failed", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    expect(() =>
      auth.pairWithToken({
        pairingToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        publicKeySpkiB64u: keys.spki.toString("base64url"),
        deviceId: keys.deviceId,
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(PairingTokenError);
  });

  it("does not burn the token when the pairing transaction rolls back", () => {
    const { auth } = freshAuth();
    const first = newDeviceKeys();
    pairDevice(auth, first); // slot now occupied

    const second = newDeviceKeys();
    const { token } = auth.mintPairingToken(T0 + 1);
    expect(() =>
      auth.pairWithToken({
        pairingToken: token,
        publicKeySpkiB64u: second.spki.toString("base64url"),
        deviceId: second.deviceId,
        accessSubject: SUBJECT,
        now: T0 + 1,
      }),
    ).toThrow(SinglePairedDeviceError);

    // Token survives the rollback: after revoking, the SAME token pairs.
    auth.revokeDevice(first.deviceId, T0 + 2, { denyPendingPermissions: () => {}, closeSockets: () => {} });
    expect(
      auth.pairWithToken({
        pairingToken: token,
        publicKeySpkiB64u: second.spki.toString("base64url"),
        deviceId: second.deviceId,
        accessSubject: SUBJECT,
        now: T0 + 3,
      }).deviceId,
    ).toBe(second.deviceId);
  });
});

// -----------------------------------------------------------------------------
// 2. SPKI DER validation
// -----------------------------------------------------------------------------

describe("SPKI validation", () => {
  it("accepts a valid P-256 SPKI, recomputes the device ID, and records the binding", () => {
    const { auth, db } = freshAuth();
    const keys = newDeviceKeys();
    const { deviceId } = pairDevice(auth, keys, { accessSubject: SUBJECT, displayName: "Pixel 9" });

    expect(deviceId).toBe(keys.deviceId);
    const row = db.prepare("SELECT * FROM devices WHERE deviceId = ?").get(deviceId) as {
      publicKeySpki: string;
      accessSubject: string;
      displayName: string;
      pairedAt: number;
      revokedAt: number | null;
    };
    expect(row.publicKeySpki).toBe(keys.spki.toString("base64url"));
    expect(row.accessSubject).toBe(SUBJECT);
    expect(row.displayName).toBe("Pixel 9");
    expect(row.pairedAt).toBe(T0);
    expect(row.revokedAt).toBeNull();
  });

  it("rejects non-P-256 keys (P-384, P-521) and non-EC keys (RSA)", () => {
    const { auth } = freshAuth();
    // P-521 SPKIs use DER long-form lengths; asserting the rejection reason
    // (curve mismatch, not a parse failure) proves the TLV parsed correctly.
    const p521 = newDeviceKeys("P-521");
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: p521.spki.toString("base64url"),
        deviceId: p521.deviceId,
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(/id-ecPublicKey with prime256v1/);

    const p384 = newDeviceKeys("P-384");
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: p384.spki.toString("base64url"),
        deviceId: p384.deviceId,
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(InvalidPublicKeyError);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaSpki = rsa.publicKey.export({ format: "der", type: "spki" }) as Buffer;
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: rsaSpki.toString("base64url"),
        deviceId: deviceIdFromSpki(rsaSpki),
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(InvalidPublicKeyError);
  });

  it("rejects malformed SPKI DER and trailing bytes", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const garbage = Buffer.from("not der at all");
    const trailing = Buffer.concat([keys.spki, Buffer.from([0x00])]);
    for (const spki of [garbage, trailing]) {
      expect(() =>
        auth.pairWithToken({
          pairingToken: auth.mintPairingToken(T0).token,
          publicKeySpkiB64u: spki.toString("base64url"),
          deviceId: deviceIdFromSpki(spki),
          accessSubject: SUBJECT,
          now: T0,
        }),
      ).toThrow(InvalidPublicKeyError);
    }
  });

  it("rejects a public key point that is not on the P-256 curve", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const spki = offCurveSpki(keys);
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: spki.toString("base64url"),
        deviceId: deviceIdFromSpki(spki),
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(InvalidPublicKeyError);
  });

  it("rejects a compressed point marker instead of the required uncompressed form", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const spki = Buffer.from(keys.spki);
    spki[spki.length - 65] = 0x02; // 0x04 (uncompressed) -> 0x02 (compressed)
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: spki.toString("base64url"),
        deviceId: deviceIdFromSpki(spki),
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(InvalidPublicKeyError);
  });

  it("rejects a claimed device ID that does not match SHA-256 of the SPKI", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    expect(() =>
      auth.pairWithToken({
        pairingToken: auth.mintPairingToken(T0).token,
        publicKeySpkiB64u: keys.spki.toString("base64url"),
        deviceId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        accessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(DeviceIdMismatchError);
  });
});

// -----------------------------------------------------------------------------
// 3. Challenge issuance
// -----------------------------------------------------------------------------

describe("issueChallenge", () => {
  it("returns a canonical UUID, 32 raw bytes, the verified subject, and a 60s expiry", () => {
    const { auth, db } = freshAuth();
    const keys = newDeviceKeys();
    const { deviceId } = pairDevice(auth, keys, { accessSubject: SUBJECT });

    const challenge = auth.issueChallenge({ deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    expect(challenge.challengeId).toMatch(LOWERCASE_UUID);
    expect(challenge.challengeRawB64u).toMatch(B64U_32BYTES);
    expect(challenge.accessSubject).toBe(SUBJECT);
    expect(challenge.expiresAt).toBe(T0 + CHALLENGE_TTL_SECONDS * 1000);

    // The bridge stores the RAW challenge bytes (it must reconstruct the
    // signed content byte-for-byte) and never writes them to any log.
    const row = db.prepare("SELECT challengeRaw, hostAscii, accessSubject FROM auth_challenges WHERE challengeId = ?")
      .get(challenge.challengeId) as { challengeRaw: Buffer; hostAscii: string; accessSubject: string };
    expect(Buffer.compare(row.challengeRaw, Buffer.from(challenge.challengeRawB64u, "base64url"))).toBe(0);
    expect(row.hostAscii).toBe(HOST);
    expect(row.accessSubject).toBe(SUBJECT);
  });

  it("rejects an unknown device", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    expect(() => auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 }))
      .toThrow(UnknownDeviceError);
  });
});

// -----------------------------------------------------------------------------
// 4. Subject binding: echo == challenge record == current assertion
// -----------------------------------------------------------------------------

describe("access-subject binding", () => {
  it("issueChallenge rejects a subject that differs from the paired record", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const { deviceId } = pairDevice(auth, keys);
    expect(() => auth.issueChallenge({ deviceId, accessSubject: OTHER_SUBJECT, hostAscii: HOST, now: T0 }))
      .toThrow(SubjectMismatchError);
  });

  it("verification rejects an echoed subject that differs from the challenge record", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    expect(() =>
      completeChallenge(auth, keys, { echoSubject: OTHER_SUBJECT }),
    ).toThrow(SubjectMismatchError);
  });

  it("verification rejects a challenge subject that differs from the current assertion", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    expect(() =>
      completeChallenge(auth, keys, { currentSubject: OTHER_SUBJECT }),
    ).toThrow(SubjectMismatchError);
  });
});

// -----------------------------------------------------------------------------
// 5. Signature verification: DER structure, r/s range, key match, bytes match
// -----------------------------------------------------------------------------

describe("signature verification", () => {
  it("accepts a valid SHA256withECDSA DER signature and issues a session", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { session } = completeChallenge(auth, keys);
    expect(session.deviceSessionToken).toMatch(B64U_32BYTES);
  });

  it("rejects a tampered signature", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    expect(() =>
      completeChallenge(auth, keys, {
        corrupt: (content) => {
          const tampered = Buffer.from(content);
          tampered[tampered.length - 1]! ^= 0x01; // flip a challengeRaw bit after signing
          return tampered;
        },
      }),
    ).toThrow(SignatureError);
  });

  it("rejects fixed-width raw r||s instead of DER", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const challenge = auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: Buffer.alloc(64, 0x11).toString("base64url"),
        currentAccessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(SignatureError);
  });

  it("rejects r = 0 and r,s >= n", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const sInt = derIntBig(randomScalarBelowN());
    const badSignatures = [
      derSeq(derIntBytes(Buffer.from([0x00])), sInt), // r = 0
      derSeq(derIntBig(P256_N), sInt), // r = n
      derSeq(sInt, derIntBig(P256_N + 1n)), // s > n
    ];
    for (const [index, der] of badSignatures.entries()) {
      const challenge = auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 + index });
      expect(() =>
        auth.verifyDeviceSignature({
          challengeId: challenge.challengeId,
          accessSubjectEcho: challenge.accessSubject,
          signatureB64u: der.toString("base64url"),
          currentAccessSubject: SUBJECT,
          now: T0 + index,
        }),
      ).toThrow(SignatureError);
    }
  });

  it("rejects non-minimal INTEGER encodings", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const s = randomScalarBelowN();
    const sBody = derIntBig(s).subarray(2); // strip 02 <len>
    const nonMinimalR = derIntBytes(Buffer.concat([Buffer.from([0x00]), sBody.subarray(0, 16)])); // redundant 0x00
    const der = derSeq(nonMinimalR, derIntBytes(sBody));
    const challenge = auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: der.toString("base64url"),
        currentAccessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(SignatureError);
  });

  it("rejects a structurally valid signature made by a different key", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const otherKeys = newDeviceKeys();
    expect(() => completeChallenge(auth, otherKeys, { deviceId: keys.deviceId })).toThrow(SignatureError);
  });

  it("rejects malformed base64url signatures and unknown challenges", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const challenge = auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: "!!not-base64url!!",
        currentAccessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(DeviceAuthError);
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: "00000000-0000-4000-8000-000000000000",
        accessSubjectEcho: SUBJECT,
        signatureB64u: "AAAA",
        currentAccessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(ChallengeError);
  });

  it("consumes the challenge on success: replay rejects even with a valid signature", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { challenge, signatureDer } = completeChallenge(auth, keys);
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: signatureDer.toString("base64url"),
        currentAccessSubject: SUBJECT,
        now: T0,
      }),
    ).toThrow(ChallengeError);
  });

  it("rejects an expired challenge", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const challenge = auth.issueChallenge({ deviceId: keys.deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    const content = buildSigningBytes({
      hostAscii: HOST,
      deviceId: keys.deviceId,
      challengeId: challenge.challengeId,
      accessSubject: challenge.accessSubject,
      challengeRaw: Buffer.from(challenge.challengeRawB64u, "base64url"),
    });
    const signatureDer = sign("sha256", content, { key: keys.privateKey, dsaEncoding: "der" });
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: signatureDer.toString("base64url"),
        currentAccessSubject: SUBJECT,
        now: T0 + CHALLENGE_TTL_SECONDS * 1000 + 1,
      }),
    ).toThrow(ChallengeError);
  });
});

// -----------------------------------------------------------------------------
// 6. Device session: hashed storage, TTL, validation
// -----------------------------------------------------------------------------

describe("device sessions", () => {
  it("issues a 256-bit token stored only as its SHA-256 hash with a 15-minute expiry", () => {
    const { auth, db } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { session } = completeChallenge(auth, keys, { now: T0 });
    expect(session.deviceSessionToken).toMatch(B64U_32BYTES);
    expect(Buffer.from(session.deviceSessionToken, "base64url").length).toBe(32);
    expect(session.expiresAt).toBe(T0 + DEFAULT_DEVICE_SESSION_TTL_SECONDS * 1000);

    const row = db.prepare("SELECT tokenHash FROM device_sessions").get() as { tokenHash: string };
    expect(row.tokenHash).toBe(createHash("sha256").update(session.deviceSessionToken).digest("hex"));
    expect(row.tokenHash).not.toContain(session.deviceSessionToken);
  });

  it("validates while unexpired and returns null at/after expiry (server clock)", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { deviceId, session } = completeChallenge(auth, keys, { now: T0 });

    expect(auth.validateDeviceSession(session.deviceSessionToken, T0)).toEqual({
      deviceId,
      accessSubject: SUBJECT,
    });
    expect(auth.validateDeviceSession(session.deviceSessionToken, T0 + 899_999)).not.toBeNull();
    expect(auth.validateDeviceSession(session.deviceSessionToken, T0 + 900_000)).toBeNull();
  });

  it("returns null for unknown, empty, and malformed tokens", () => {
    const { auth } = freshAuth();
    expect(auth.validateDeviceSession("", T0)).toBeNull();
    expect(auth.validateDeviceSession("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", T0)).toBeNull();
    expect(auth.validateDeviceSession("not a token", T0)).toBeNull();
  });

  it("honors a custom deviceSessionTtlSeconds option", () => {
    const { auth } = freshAuth(1);
    const keys = newDeviceKeys();
    pairDevice(auth, keys, { now: T0 });
    const { session } = completeChallenge(auth, keys, { now: T0 });
    expect(session.expiresAt).toBe(T0 + 1_000);
    expect(auth.validateDeviceSession(session.deviceSessionToken, T0)).not.toBeNull();
    expect(auth.validateDeviceSession(session.deviceSessionToken, T0 + 1_000)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 7. Refresh requires a fresh challenge signature
// -----------------------------------------------------------------------------

describe("session refresh", () => {
  it("an expired session cannot be renewed; a fresh challenge + signature re-authenticates", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { deviceId, session } = completeChallenge(auth, keys, { now: T0 });

    const atExpiry = T0 + 901_000;
    expect(auth.validateDeviceSession(session.deviceSessionToken, atExpiry)).toBeNull();

    const refreshed = completeChallenge(auth, keys, { now: atExpiry });
    expect(refreshed.session.deviceSessionToken).not.toBe(session.deviceSessionToken);
    expect(auth.validateDeviceSession(refreshed.session.deviceSessionToken, atExpiry)).toEqual({
      deviceId,
      accessSubject: SUBJECT,
    });
  });
});

// -----------------------------------------------------------------------------
// 8. Revocation
// -----------------------------------------------------------------------------

describe("revokeDevice", () => {
  it("deletes sessions and challenges, marks the device, and invokes both hooks", () => {
    const { auth, db } = freshAuth();
    const keys = newDeviceKeys();
    pairDevice(auth, keys);
    const { deviceId, session } = completeChallenge(auth, keys, { now: T0 });
    // A second outstanding challenge and a pending permission/socket exist.
    auth.issueChallenge({ deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    const denyPendingPermissions = vi.fn();
    const closeSockets = vi.fn();

    auth.revokeDevice(deviceId, T0 + 1, { denyPendingPermissions, closeSockets });

    expect(denyPendingPermissions).toHaveBeenCalledTimes(1);
    expect(denyPendingPermissions).toHaveBeenCalledWith(deviceId);
    expect(closeSockets).toHaveBeenCalledTimes(1);
    expect(closeSockets).toHaveBeenCalledWith(deviceId);

    expect((db.prepare("SELECT revokedAt FROM devices WHERE deviceId = ?").get(deviceId) as { revokedAt: number }).revokedAt)
      .toBe(T0 + 1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM device_sessions WHERE deviceId = ?").get(deviceId) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM auth_challenges WHERE deviceId = ?").get(deviceId) as { n: number }).n).toBe(0);
    expect(auth.validateDeviceSession(session.deviceSessionToken, T0 + 2)).toBeNull();
  });

  it("rejects later signatures even if valid, and refuses new challenges", () => {
    const { auth } = freshAuth();
    const keys = newDeviceKeys();
    const { deviceId } = pairDevice(auth, keys);
    const challenge = auth.issueChallenge({ deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 });
    auth.revokeDevice(deviceId, T0 + 1, { denyPendingPermissions: () => {}, closeSockets: () => {} });

    const content = buildSigningBytes({
      hostAscii: HOST,
      deviceId,
      challengeId: challenge.challengeId,
      accessSubject: challenge.accessSubject,
      challengeRaw: Buffer.from(challenge.challengeRawB64u, "base64url"),
    });
    const signatureDer = sign("sha256", content, { key: keys.privateKey, dsaEncoding: "der" });
    expect(() =>
      auth.verifyDeviceSignature({
        challengeId: challenge.challengeId,
        accessSubjectEcho: challenge.accessSubject,
        signatureB64u: signatureDer.toString("base64url"),
        currentAccessSubject: SUBJECT,
        now: T0 + 2,
      }),
    ).toThrow(DeviceAuthError); // challenge deleted + device revoked
    expect(() => auth.issueChallenge({ deviceId, accessSubject: SUBJECT, hostAscii: HOST, now: T0 + 2 }))
      .toThrow(DeviceRevokedError);
  });

  it("throws for an unknown device", () => {
    const { auth } = freshAuth();
    expect(() =>
      auth.revokeDevice("unknown-device", T0, { denyPendingPermissions: () => {}, closeSockets: () => {} }),
    ).toThrow(UnknownDeviceError);
  });
});

// -----------------------------------------------------------------------------
// 9. One paired device; new pairing requires prior revocation
// -----------------------------------------------------------------------------

describe("one-device invariant", () => {
  it("rejects a second pairing while a device is active", () => {
    const { auth } = freshAuth();
    const first = newDeviceKeys();
    pairDevice(auth, first);
    const second = newDeviceKeys();
    expect(() => pairDevice(auth, second, { now: T0 + 1 })).toThrow(SinglePairedDeviceError);
    expect(auth.listDevices()).toHaveLength(1);
  });

  it("allows a new pairing after revocation; listDevices shows both", () => {
    const { auth } = freshAuth();
    const first = newDeviceKeys();
    const { deviceId: firstId } = pairDevice(auth, first, { displayName: "Old phone" });
    auth.revokeDevice(firstId, T0 + 1, { denyPendingPermissions: () => {}, closeSockets: () => {} });

    const second = newDeviceKeys();
    const { deviceId: secondId } = pairDevice(auth, second, { now: T0 + 2, displayName: "New phone" });

    const devices = auth.listDevices();
    expect(devices).toHaveLength(2);
    const old = devices.find((d) => d.deviceId === firstId)!;
    const current = devices.find((d) => d.deviceId === secondId)!;
    expect(old.revokedAt).toBe(T0 + 1);
    expect(current.revokedAt).toBeNull();
    expect(current.displayName).toBe("New phone");
    expect(current.accessSubject).toBe(SUBJECT);
  });
});

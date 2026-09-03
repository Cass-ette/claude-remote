/**
 * Device pairing, challenge, session, and revocation lifecycle (spec §10.3,
 * §10.4). Cryptography-heaviest module of the public-network security layer.
 *
 * SECURITY INVARIANTS:
 * - Pairing tokens, challenge raw bytes, and device session tokens never
 *   appear in errors or logs; pairing_tokens/device_sessions store only
 *   SHA-256 hashes. auth_challenges stores the RAW challenge bytes because
 *   the bridge must reconstruct the signed content byte-for-byte; the row is
 *   deleted on successful consumption, expiry, or revocation (§10.3).
 * - The SPKI is parsed with a strict DER shape check (id-ecPublicKey +
 *   prime256v1, uncompressed point) AND an on-curve check; the device ID is
 *   always recomputed server-side and never trusted from the client.
 * - Signatures must be ASN.1 DER SEQUENCE(INTEGER r, INTEGER s) with
 *   1 <= r,s < n — fixed-width r||s and malleable/non-minimal encodings are
 *   rejected before OpenSSL verification.
 * - An echoed accessSubject must equal the challenge record's subject AND the
 *   CURRENT verified Access assertion's subject.
 * - Only one non-revoked device may exist; pairing a new device requires
 *   prior revocation (§10.3).
 * - All timestamps are injected by callers (`now`, ms since epoch); the
 *   module never reads the clock.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { transaction as runInTransaction, type SqliteDatabase } from "../db/database.js";
import { buildSigningBytes, normalizeHost } from "./signing-bytes.js";

/** Pairing token lifetime (spec §10.3: five minutes, single-use). */
export const PAIRING_TOKEN_TTL_SECONDS = 300;
/** Challenge lifetime (spec §10.3: sixty seconds, single-use). */
export const CHALLENGE_TTL_SECONDS = 60;
/** Device session token lifetime (spec §10.3: fifteen minutes). */
export const DEFAULT_DEVICE_SESSION_TTL_SECONDS = 900;

// --- P-256 domain parameters -------------------------------------------------

const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** OID 1.2.840.10045.2.1 (id-ecPublicKey), content bytes only. */
const OID_EC_PUBLIC_KEY = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
/** OID 1.2.840.10045.3.1.7 (prime256v1 / secp256r1), content bytes only. */
const OID_PRIME256V1 = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);

// --- Error model --------------------------------------------------------------
// Route mapping (Task 24) collapses all of these into a uniform, detail-free
// authentication failure (§10.3); typed classes exist for tests and admin UX.

/** Base class of every device-auth failure. */
export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAuthError";
  }
}

/** Pairing token unknown, expired, or already used (deliberately uniform). */
export class PairingTokenError extends DeviceAuthError {
  constructor() {
    super("pairing token is unknown, expired, or already used");
    this.name = "PairingTokenError";
  }
}

/** SPKI is not a valid P-256 SubjectPublicKeyInfo / point not on the curve. */
export class InvalidPublicKeyError extends DeviceAuthError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublicKeyError";
  }
}

/** Claimed deviceId does not equal base64url(SHA-256(SPKI DER)). */
export class DeviceIdMismatchError extends DeviceAuthError {
  constructor() {
    super("submitted deviceId does not match SHA-256 of the submitted public key");
    this.name = "DeviceIdMismatchError";
  }
}

/** Another non-revoked device is already paired (§10.3 one-device rule). */
export class SinglePairedDeviceError extends DeviceAuthError {
  constructor() {
    super("a device is already paired; revoke it before pairing a new device");
    this.name = "SinglePairedDeviceError";
  }
}

/** No device record with the given deviceId. */
export class UnknownDeviceError extends DeviceAuthError {
  constructor(message = "unknown device") {
    super(message);
    this.name = "UnknownDeviceError";
  }
}

/** The device record is revoked; all later signatures fail (§10.4). */
export class DeviceRevokedError extends DeviceAuthError {
  constructor() {
    super("device is revoked");
    this.name = "DeviceRevokedError";
  }
}

/** Challenge unknown, expired, or already consumed (deliberately uniform). */
export class ChallengeError extends DeviceAuthError {
  constructor(message = "challenge is unknown, expired, or already used") {
    super(message);
    this.name = "ChallengeError";
  }
}

/** Echoed/recorded/current Access subjects do not all agree byte-for-byte. */
export class SubjectMismatchError extends DeviceAuthError {
  constructor(message: string) {
    super(message);
    this.name = "SubjectMismatchError";
  }
}

/** Signature is malformed DER, out of range, or fails verification. */
export class SignatureError extends DeviceAuthError {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

// --- Helpers -------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Strict unpadded-base64url decode: charset-validated and round-trip checked,
 * because Buffer.from silently ignores invalid characters.
 */
function decodeB64u(value: string, field: string): Buffer {
  if (typeof value !== "string" || value === "") {
    throw new DeviceAuthError(`${field} must be a non-empty string`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new DeviceAuthError(`${field} is not canonical unpadded base64url`);
  }
  return decoded;
}

/** Device ID = base64url_no_pad(SHA-256(SPKI DER)) (§10.3). */
export function deviceIdFromSpki(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest().toString("base64url");
}

// --- Strict DER parsing ---------------------------------------------------------

interface DerTlv {
  readonly tag: number;
  readonly content: Buffer;
  /** Offset just past this TLV. */
  readonly next: number;
}

/** Read one TLV with strict, minimal DER length encoding. */
function readDerTlv(buf: Buffer, offset: number, what: string): DerTlv {
  if (offset + 2 > buf.length) {
    throw new Error(`${what}: truncated TLV header`);
  }
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) {
    throw new Error(`${what}: multi-byte tags are not expected`);
  }
  const firstLengthByte = buf[offset + 1]!;
  let length: number;
  let headerSize = 2;
  if (firstLengthByte < 0x80) {
    length = firstLengthByte;
  } else {
    const lengthBytes = firstLengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error(`${what}: indefinite or oversized length`);
    }
    if (offset + 2 + lengthBytes > buf.length) {
      throw new Error(`${what}: truncated length`);
    }
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) {
      length = length * 256 + buf[offset + 2 + i]!;
    }
    // Minimal encoding: the long form is only for values >= 0x80 and never
    // carries a leading zero length byte.
    if (length < 0x80 || buf[offset + 2] === 0) {
      throw new Error(`${what}: non-minimal length encoding`);
    }
    headerSize = 2 + lengthBytes;
  }
  const end = offset + headerSize + length;
  if (end > buf.length) {
    throw new Error(`${what}: content exceeds buffer`);
  }
  return { tag, content: buf.subarray(offset + headerSize, end), next: end };
}

/**
 * Validate that `spki` is exactly `SEQUENCE { SEQUENCE { id-ecPublicKey,
 * prime256v1 }, BIT STRING { 0 unused bits, 0x04 || x || y } }` with the point
 * ON the P-256 curve. Throws InvalidPublicKeyError otherwise. Point arithmetic
 * uses BigInt over the prime field (y^2 = x^3 - 3x + b mod p).
 */
function parseSpkiP256(spki: Buffer): void {
  const fail = (why: string): never => {
    throw new InvalidPublicKeyError(`SPKI rejected: ${why}`);
  };
  let outer: DerTlv;
  let alg: DerTlv;
  let bitString: DerTlv;
  let oid1: DerTlv;
  let oid2: DerTlv;
  try {
    outer = readDerTlv(spki, 0, "SPKI");
    alg = readDerTlv(outer.content, 0, "algorithm");
    bitString = readDerTlv(outer.content, alg.next, "subjectPublicKey");
    oid1 = readDerTlv(alg.content, 0, "algorithm OID");
    oid2 = readDerTlv(alg.content, oid1.next, "curve OID");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "malformed DER");
  }
  if (outer.tag !== 0x30 || outer.next !== spki.length) {
    fail("expected a single top-level SEQUENCE covering the whole SPKI");
  }
  if (alg.tag !== 0x30) {
    fail("expected an AlgorithmIdentifier SEQUENCE");
  }
  if (oid1.tag !== 0x06 || oid2.tag !== 0x06 || oid2.next !== alg.content.length) {
    fail("expected exactly two algorithm OIDs");
  }
  if (!oid1.content.equals(OID_EC_PUBLIC_KEY) || !oid2.content.equals(OID_PRIME256V1)) {
    fail("must use id-ecPublicKey with prime256v1 (secp256r1)");
  }
  if (bitString.tag !== 0x03 || bitString.next !== outer.content.length) {
    fail("expected a BIT STRING public key");
  }
  const point = bitString.content;
  if (point.length !== 66 || point[0] !== 0x00) {
    fail("BIT STRING must have zero unused bits and a 65-byte uncompressed point");
  }
  if (point[1] !== 0x04) {
    fail("public key point must be uncompressed (0x04 prefix)");
  }
  const x = BigInt(`0x${point.subarray(2, 34).toString("hex")}`);
  const y = BigInt(`0x${point.subarray(34, 66).toString("hex")}`);
  if (x >= P256_P || y >= P256_P) {
    fail("point coordinates are not field elements");
  }
  const left = (y * y) % P256_P;
  const right = (x * x * x - 3n * x + P256_B) % P256_P;
  if (left !== right) {
    fail("public key point is not on the P-256 curve");
  }
}

/**
 * Strictly parse an ECDSA signature: `SEQUENCE { INTEGER r, INTEGER s }`,
 * positive minimally-encoded integers, no trailing garbage, with
 * 1 <= r,s < n (P-256 order). Rejects fixed-width r||s, negative/zero values,
 * and values >= n before OpenSSL sees them.
 */
function parseEcdsaDerSignature(der: Buffer): void {
  const fail = (why: string): never => {
    throw new SignatureError(`signature rejected: ${why}`);
  };
  let seq: DerTlv;
  let rTlv: DerTlv;
  let sTlv: DerTlv;
  try {
    seq = readDerTlv(der, 0, "signature");
    rTlv = readDerTlv(seq.content, 0, "r");
    sTlv = readDerTlv(seq.content, rTlv.next, "s");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "malformed DER");
  }
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    fail("expected a single SEQUENCE(INTEGER r, INTEGER s)");
  }
  if (rTlv.tag !== 0x02 || sTlv.tag !== 0x02 || sTlv.next !== seq.content.length) {
    fail("expected exactly two INTEGERs");
  }
  const r = decodeDerPositiveInteger(rTlv.content, "r");
  const s = decodeDerPositiveInteger(sTlv.content, "s");
  if (r === 0n || s === 0n) {
    fail("r and s must be at least 1");
  }
  if (r >= P256_N || s >= P256_N) {
    fail("r and s must be below the P-256 group order");
  }
}

function decodeDerPositiveInteger(content: Buffer, name: string): bigint {
  if (content.length === 0) {
    throw new SignatureError(`signature rejected: ${name} is empty`);
  }
  if ((content[0]! & 0x80) !== 0) {
    throw new SignatureError(`signature rejected: ${name} is negative`);
  }
  let body = content;
  if (content[0] === 0x00) {
    if (content.length < 2 || (content[1]! & 0x80) === 0) {
      throw new SignatureError(`signature rejected: ${name} is not minimally encoded`);
    }
    body = content.subarray(1);
  }
  return BigInt(`0x${body.toString("hex")}`);
}

// --- Public interface ------------------------------------------------------------

export interface PairWithTokenInput {
  readonly pairingToken: string;
  /** Unpadded base64url X.509 SubjectPublicKeyInfo DER (§10.3 step 4). */
  readonly publicKeySpkiB64u: string;
  /** Client-claimed device ID; must equal the server-side recomputation. */
  readonly deviceId: string;
  /** Subject of the CURRENT verified Cloudflare Access assertion. */
  readonly accessSubject: string;
  readonly displayName?: string | undefined;
  readonly now: number;
}

export interface IssueChallengeInput {
  readonly deviceId: string;
  /** Subject of the CURRENT verified assertion; must match the device record. */
  readonly accessSubject: string;
  /** Bridge public host (URL or canonical hostAscii); normalized before storage. */
  readonly hostAscii: string;
  readonly now: number;
}

export interface IssuedChallenge {
  readonly challengeId: string;
  /** 32 random bytes, unpadded base64url (§10.3: returned to the client). */
  readonly challengeRawB64u: string;
  /** The verified Access subject the client MUST sign verbatim. */
  readonly accessSubject: string;
  readonly expiresAt: number;
}

export interface VerifySignatureInput {
  readonly challengeId: string;
  /** Subject echoed back by the device; must equal record AND current assertion. */
  readonly accessSubjectEcho: string;
  /** ASN.1 DER SEQUENCE(INTEGER r, INTEGER s), unpadded base64url. */
  readonly signatureB64u: string;
  /** Subject of the CURRENT verified assertion at verification time. */
  readonly currentAccessSubject: string;
  readonly now: number;
}

export interface IssuedDeviceSession {
  /** 256-bit opaque bearer token (§10.3); only its hash is stored. */
  readonly deviceSessionToken: string;
  readonly expiresAt: number;
}

export interface ValidatedDeviceSession {
  readonly deviceId: string;
  readonly accessSubject: string;
}

/** Caller-injected revocation side effects (§10.4); the auth module owns neither. */
export interface RevocationHooks {
  denyPendingPermissions(deviceId: string): void;
  closeSockets(deviceId: string): void;
}

export interface DeviceSummary {
  readonly deviceId: string;
  readonly displayName: string;
  readonly accessSubject: string;
  readonly pairedAt: number;
  readonly revokedAt: number | null;
}

export interface DeviceAuthOptions {
  /** Device session TTL in seconds; default 900 (spec §10.3: fifteen minutes). */
  readonly deviceSessionTtlSeconds?: number | undefined;
}

export interface DeviceAuth {
  /** Local-admin: mint a 256-bit single-use pairing token (5-minute TTL). */
  mintPairingToken(now: number): { readonly token: string; readonly expiresAt: number };

  pairWithToken(input: PairWithTokenInput): { readonly deviceId: string };

  issueChallenge(input: IssueChallengeInput): IssuedChallenge;

  verifyDeviceSignature(input: VerifySignatureInput): IssuedDeviceSession;

  /** Bearer check for every request; null when missing, expired, or revoked. */
  validateDeviceSession(token: string, now: number): ValidatedDeviceSession | null;

  revokeDevice(deviceId: string, now: number, hooks: RevocationHooks): void;

  listDevices(): DeviceSummary[];
}

// --- Implementation ----------------------------------------------------------------

interface DeviceRow {
  deviceId: string;
  publicKeySpki: string;
  accessSubject: string;
  displayName: string;
  pairedAt: number;
  revokedAt: number | null;
}

interface ChallengeRow {
  challengeId: string;
  deviceId: string;
  accessSubject: string;
  hostAscii: string;
  challengeRaw: Buffer;
  expiresAt: number;
  consumedAt: number | null;
}

export function createDeviceAuth(db: SqliteDatabase, options: DeviceAuthOptions = {}): DeviceAuth {
  const deviceSessionTtlSeconds = options.deviceSessionTtlSeconds ?? DEFAULT_DEVICE_SESSION_TTL_SECONDS;
  if (!Number.isInteger(deviceSessionTtlSeconds) || deviceSessionTtlSeconds <= 0) {
    throw new Error("deviceSessionTtlSeconds must be a positive integer");
  }

  const insertPairingToken = db.prepare(
    "INSERT INTO pairing_tokens (tokenHash, expiresAt, consumedAt, createdAt) VALUES (?, ?, NULL, ?)",
  );
  const consumePairingToken = db.prepare(
    "UPDATE pairing_tokens SET consumedAt = ? WHERE tokenHash = ? AND consumedAt IS NULL AND expiresAt > ?",
  );
  const insertDevice = db.prepare(
    "INSERT INTO devices (deviceId, publicKeySpki, accessSubject, displayName, pairedAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  const getDevice = db.prepare("SELECT * FROM devices WHERE deviceId = ?");
  const getActiveDevice = db.prepare("SELECT deviceId FROM devices WHERE revokedAt IS NULL");
  const listDeviceRows = db.prepare("SELECT * FROM devices ORDER BY pairedAt, deviceId");
  const revokeDeviceRow = db.prepare(
    "UPDATE devices SET revokedAt = ? WHERE deviceId = ? AND revokedAt IS NULL",
  );
  const insertChallenge = db.prepare(
    `INSERT INTO auth_challenges (challengeId, deviceId, accessSubject, hostAscii, challengeRaw, expiresAt, consumedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const getChallenge = db.prepare("SELECT * FROM auth_challenges WHERE challengeId = ?");
  const deleteChallengeForConsume = db.prepare(
    "DELETE FROM auth_challenges WHERE challengeId = ? AND consumedAt IS NULL",
  );
  const deleteExpiredChallenges = db.prepare("DELETE FROM auth_challenges WHERE expiresAt <= ?");
  const deleteDeviceChallenges = db.prepare("DELETE FROM auth_challenges WHERE deviceId = ?");
  const insertDeviceSession = db.prepare(
    "INSERT INTO device_sessions (tokenHash, deviceId, accessSubject, expiresAt, revokedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)",
  );
  const getSession = db.prepare(
    `SELECT ds.expiresAt, ds.deviceId, ds.accessSubject, ds.revokedAt AS sessionRevokedAt,
            d.revokedAt AS deviceRevokedAt
     FROM device_sessions ds JOIN devices d ON d.deviceId = ds.deviceId
     WHERE ds.tokenHash = ?`,
  );
  const deleteDeviceSessions = db.prepare("DELETE FROM device_sessions WHERE deviceId = ?");

  const tx = runInTransaction.bind(null, db) as <T>(fn: () => T) => T;

  return {
    mintPairingToken(now) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now + PAIRING_TOKEN_TTL_SECONDS * 1000;
      insertPairingToken.run(sha256Hex(token), expiresAt, now);
      return { token, expiresAt };
    },

    pairWithToken(input) {
      // Pure validation first; nothing is consumed while the inputs are bad.
      const spki = decodeB64u(input.publicKeySpkiB64u, "publicKeySpki");
      parseSpkiP256(spki);
      const computedDeviceId = deviceIdFromSpki(spki);
      if (input.deviceId !== computedDeviceId) {
        throw new DeviceIdMismatchError();
      }
      if (typeof input.accessSubject !== "string" || input.accessSubject === "") {
        throw new DeviceAuthError("accessSubject must be a non-empty string");
      }
      const displayName = input.displayName === undefined || input.displayName.trim() === ""
        ? "Android device"
        : input.displayName.trim().slice(0, 128);

      // Atomic consumption + slot check + insert in ONE transaction: a
      // SinglePairedDeviceError rolls back the token consumption, so the QR
      // stays usable after the user revokes the old device.
      tx(() => {
        const consumed = consumePairingToken.run(input.now, sha256Hex(input.pairingToken), input.now);
        if (consumed.changes !== 1) {
          throw new PairingTokenError();
        }
        if (getActiveDevice.get() !== undefined) {
          throw new SinglePairedDeviceError();
        }
        insertDevice.run(computedDeviceId, spki.toString("base64url"), input.accessSubject, displayName, input.now);
      });
      return { deviceId: computedDeviceId };
    },

    issueChallenge(input) {
      const device = getDevice.get(input.deviceId) as DeviceRow | undefined;
      if (device === undefined) {
        throw new UnknownDeviceError();
      }
      if (device.revokedAt !== null) {
        throw new DeviceRevokedError();
      }
      if (device.accessSubject !== input.accessSubject) {
        throw new SubjectMismatchError("current Access subject does not match the paired device record");
      }
      const hostAscii = normalizeHost(input.hostAscii);
      deleteExpiredChallenges.run(input.now);
      const challengeId = randomUUID();
      const challengeRaw = randomBytes(32);
      const expiresAt = input.now + CHALLENGE_TTL_SECONDS * 1000;
      insertChallenge.run(
        challengeId,
        input.deviceId,
        device.accessSubject,
        hostAscii,
        challengeRaw,
        expiresAt,
        input.now,
      );
      return {
        challengeId,
        challengeRawB64u: challengeRaw.toString("base64url"),
        accessSubject: device.accessSubject,
        expiresAt,
      };
    },

    verifyDeviceSignature(input) {
      if (typeof input.challengeId !== "string" || input.challengeId === "") {
        throw new ChallengeError("challengeId must be a non-empty string");
      }
      const challenge = getChallenge.get(input.challengeId) as ChallengeRow | undefined;
      if (challenge === undefined) {
        // Also covers replay: rows are deleted on successful consumption.
        throw new ChallengeError();
      }
      if (challenge.consumedAt !== null) {
        throw new ChallengeError();
      }
      if (challenge.expiresAt <= input.now) {
        throw new ChallengeError();
      }
      if (input.accessSubjectEcho !== challenge.accessSubject) {
        throw new SubjectMismatchError("echoed accessSubject does not match the challenge record");
      }
      if (challenge.accessSubject !== input.currentAccessSubject) {
        throw new SubjectMismatchError("challenge accessSubject does not match the current assertion");
      }
      const device = getDevice.get(challenge.deviceId) as DeviceRow | undefined;
      if (device === undefined) {
        throw new UnknownDeviceError();
      }
      if (device.revokedAt !== null) {
        // §10.4: later signatures fail even when valid.
        throw new DeviceRevokedError();
      }

      const signatureDer = decodeB64u(input.signatureB64u, "signatureDer");
      parseEcdsaDerSignature(signatureDer);

      const signingBytes = buildSigningBytes({
        hostAscii: challenge.hostAscii,
        deviceId: challenge.deviceId,
        challengeId: challenge.challengeId,
        accessSubject: challenge.accessSubject,
        challengeRaw: challenge.challengeRaw,
      });
      let verified = false;
      try {
        const key: KeyObject = createPublicKey({
          key: Buffer.from(device.publicKeySpki, "base64url"),
          format: "der",
          type: "spki",
        });
        verified = verify("sha256", signingBytes, key, signatureDer);
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new SignatureError("device signature verification failed");
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = input.now + deviceSessionTtlSeconds * 1000;
      // Consume the challenge and mint the session atomically: the DELETE is
      // the single-use gate (a concurrent replay sees no row), and deleting
      // the row also erases the stored challengeRaw as §10.3 requires.
      tx(() => {
        const deleted = deleteChallengeForConsume.run(challenge.challengeId);
        if (deleted.changes !== 1) {
          throw new ChallengeError();
        }
        insertDeviceSession.run(sha256Hex(token), challenge.deviceId, challenge.accessSubject, expiresAt, input.now);
      });
      return { deviceSessionToken: token, expiresAt };
    },

    validateDeviceSession(token, now) {
      if (typeof token !== "string" || token === "") {
        return null;
      }
      // Lookup by SHA-256 hash: the index key is the hash of the presented
      // token, so equality on the indexed column leaks no timing signal that
      // a constant-time comparison would protect against.
      const row = getSession.get(sha256Hex(token)) as
        | {
            expiresAt: number;
            deviceId: string;
            accessSubject: string;
            sessionRevokedAt: number | null;
            deviceRevokedAt: number | null;
          }
        | undefined;
      if (row === undefined) return null;
      if (row.expiresAt <= now) return null;
      if (row.sessionRevokedAt !== null || row.deviceRevokedAt !== null) return null;
      return { deviceId: row.deviceId, accessSubject: row.accessSubject };
    },

    revokeDevice(deviceId, now, hooks) {
      const device = getDevice.get(deviceId) as DeviceRow | undefined;
      if (device === undefined) {
        throw new UnknownDeviceError();
      }
      tx(() => {
        revokeDeviceRow.run(now, deviceId);
        deleteDeviceSessions.run(deviceId);
        deleteDeviceChallenges.run(deviceId);
      });
      // Side effects run after the transaction commits: the connection
      // registry and permission broker are caller-owned (§10.4).
      hooks.denyPendingPermissions(deviceId);
      hooks.closeSockets(deviceId);
    },

    listDevices() {
      return (listDeviceRows.all() as DeviceRow[]).map((row) => ({
        deviceId: row.deviceId,
        displayName: row.displayName,
        accessSubject: row.accessSubject,
        pairedAt: row.pairedAt,
        revokedAt: row.revokedAt,
      }));
    },
  };
}

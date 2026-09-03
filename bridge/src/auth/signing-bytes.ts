/**
 * Canonical device-auth signing bytes and host normalization (spec §10.3).
 *
 * The signing content is the exact byte string both the Bridge and the
 * Android app construct for device-auth signatures:
 *
 * ```text
 * ASCII("CLAUDE-REMOTE-DEVICE-AUTH-V1") || 0x00 ||
 * u16be(len(hostAscii))       || UTF8(hostAscii) ||
 * u16be(len(deviceId))        || ASCII(deviceId) ||
 * u16be(len(challengeId))     || ASCII(challengeId) ||
 * u32be(len(accessSubject))   || UTF8(accessSubject) ||
 * challengeRaw[32]
 * ```
 *
 * All lengths are unsigned big-endian BYTE lengths of the following encoded
 * field. `accessSubject` is UTF-8 encoded as received — never Unicode
 * normalized. This module is pure: no I/O, no clock, no crypto.
 */
import { domainToASCII } from "node:url";

/** Domain-separation prefix of the signing content (§10.3). */
export const SIGNING_CONTEXT = "CLAUDE-REMOTE-DEVICE-AUTH-V1";

/** Thrown when a host/URL input cannot be normalized to a canonical host. */
export class InvalidHostException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHostException";
  }
}

/** Thrown when the fields of the signing content are malformed. */
export class SigningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningInputError";
  }
}

/**
 * Normalizes the Bridge public URL (or a bare canonical host) to the exact
 * `hostAscii` string used in signatures (§10.3):
 *
 * - scheme must be `https` (a bare hostname without scheme is also accepted,
 *   matching the stored canonical form);
 * - no userinfo, query, or fragment;
 * - path must be empty or `/`;
 * - port must be empty or `443` (WHATWG URL drops the default `:443`);
 * - hostname is IDNA ToASCII'd, lowercased, and stripped of its trailing dot;
 * - the scheme, path, and `:443` never appear in the signed host.
 */
export function normalizeHost(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidHostException("host input must be a string");
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new InvalidHostException("host input is empty");
  }

  let hostname: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new InvalidHostException(`host input is not a valid URL: ${JSON.stringify(trimmed)}`);
    }
    if (url.protocol !== "https:") {
      throw new InvalidHostException(`host URL scheme must be https: ${JSON.stringify(trimmed)}`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new InvalidHostException(`host URL must not contain userinfo: ${JSON.stringify(trimmed)}`);
    }
    if (url.search !== "") {
      throw new InvalidHostException(`host URL must not contain a query: ${JSON.stringify(trimmed)}`);
    }
    if (url.hash !== "") {
      throw new InvalidHostException(`host URL must not contain a fragment: ${JSON.stringify(trimmed)}`);
    }
    if (url.pathname !== "/") {
      throw new InvalidHostException(`host URL path must be empty or "/": ${JSON.stringify(trimmed)}`);
    }
    if (url.port !== "") {
      // url.port is "" for https even when the input spelled out ":443".
      throw new InvalidHostException(`host URL port must be empty or 443: ${JSON.stringify(trimmed)}`);
    }
    hostname = url.hostname;
  } else {
    if (/[/@?#:]/.test(trimmed)) {
      throw new InvalidHostException(`bare host must not contain URL delimiters: ${JSON.stringify(trimmed)}`);
    }
    hostname = trimmed;
  }

  const ascii = domainToASCII(hostname.toLowerCase());
  if (ascii === undefined || ascii === "") {
    throw new InvalidHostException(`hostname has no IDNA A-label form: ${JSON.stringify(hostname)}`);
  }
  const withoutRootDot = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (withoutRootDot === "") {
    throw new InvalidHostException("hostname is empty after normalization");
  }
  // domainToASCII passes structurally invalid ASCII input (e.g. "a..b")
  // through unchanged, so empty and non-LDH labels are rejected here.
  for (const label of withoutRootDot.split(".")) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new InvalidHostException(
        `hostname contains an invalid label (${JSON.stringify(label)}) in ${JSON.stringify(input)}`,
      );
    }
  }
  if (withoutRootDot.length > 253) {
    throw new InvalidHostException("normalized hostname exceeds 253 characters");
  }
  return withoutRootDot;
}

/** Printable ASCII (no spaces, no control bytes) — required for host/device/challenge fields. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export interface SigningBytesInput {
  /** Canonical signed host (see {@link normalizeHost}). */
  readonly hostAscii: string;
  /** base64url_no_pad(SHA-256(SPKI DER)) — ASCII by construction. */
  readonly deviceId: string;
  /** Canonical lowercase UUID — ASCII by construction. */
  readonly challengeId: string;
  /** Verified Access subject string, UTF-8 encoded verbatim (no Unicode normalization). */
  readonly accessSubject: string;
  /** The 32-byte challenge; stored raw by the bridge for exact reconstruction. */
  readonly challengeRaw: Buffer;
}

function requirePrintableAscii(value: string, field: string): Buffer {
  if (typeof value !== "string" || value === "") {
    throw new SigningInputError(`${field} must be a non-empty string`);
  }
  if (!PRINTABLE_ASCII.test(value)) {
    throw new SigningInputError(`${field} must be printable ASCII`);
  }
  return Buffer.from(value, "ascii");
}

function u16be(value: number, field: string): Buffer {
  if (value > 0xffff) {
    throw new SigningInputError(`${field} exceeds the u16 length prefix`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

function u32be(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

/**
 * Build the exact signing content for a device-auth signature. Throws
 * {@link SigningInputError} on any malformed field so callers never sign
 * degenerate input.
 */
export function buildSigningBytes(input: SigningBytesInput): Buffer {
  if (!Buffer.isBuffer(input.challengeRaw)) {
    throw new SigningInputError("challengeRaw must be a Buffer");
  }
  if (input.challengeRaw.length !== 32) {
    throw new SigningInputError(`challengeRaw must be exactly 32 bytes; got ${input.challengeRaw.length}`);
  }
  const hostBytes = requirePrintableAscii(input.hostAscii, "hostAscii");
  const deviceBytes = requirePrintableAscii(input.deviceId, "deviceId");
  const challengeIdBytes = requirePrintableAscii(input.challengeId, "challengeId");
  if (typeof input.accessSubject !== "string" || input.accessSubject === "") {
    throw new SigningInputError("accessSubject must be a non-empty string");
  }
  const subjectBytes = Buffer.from(input.accessSubject, "utf8");
  if (subjectBytes.length > 0xffffffff) {
    throw new SigningInputError("accessSubject exceeds the u32 length prefix");
  }

  return Buffer.concat([
    Buffer.from(SIGNING_CONTEXT, "ascii"),
    Buffer.from([0x00]),
    u16be(hostBytes.length, "hostAscii"),
    hostBytes,
    u16be(deviceBytes.length, "deviceId"),
    deviceBytes,
    u16be(challengeIdBytes.length, "challengeId"),
    challengeIdBytes,
    u32be(subjectBytes.length),
    subjectBytes,
    input.challengeRaw,
  ]);
}

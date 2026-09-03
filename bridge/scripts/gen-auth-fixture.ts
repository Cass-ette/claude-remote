/**
 * One-shot generator for contracts/v1/auth-signing-fixture.json (spec §10.3).
 *
 * The fixture is the shared cross-implementation test vector for the device
 * auth signing protocol: the same fixed P-256 test keypair, host, subject,
 * challenge, signing content, and a DER signature that BOTH the TypeScript
 * Bridge and the Android app must verify over identical bytes.
 *
 * This script deliberately constructs the signing content INLINE instead of
 * importing src/auth/signing-bytes.ts, so the fixture is an independent
 * construction of the wire format. Run once, commit the JSON, never
 * regenerate: Node's ECDSA uses a random nonce, so re-running produces a
 * different (but equally verifiable) signature while Android may have pinned
 * the committed one.
 *
 * Usage (from the repo root): npx tsx bridge/scripts/gen-auth-fixture.ts
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { domainToASCII } from "node:url";

// -----------------------------------------------------------------------------
// Fixed inputs. Generated once; changing any of them invalidates the committed
// fixture and requires a NEW fixture file, not an in-place regeneration.
// -----------------------------------------------------------------------------

/** Fixed P-256 test private key (PKCS#8 DER, base64). Test key ONLY. */
const FIXTURE_PRIVATE_KEY_PKCS8_B64 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQMmtigwgKoXMTwqa1CC2Z0dW5RTGskxRj0V1mQyalwChRANCAATHMhbRaV18R+fB0wIG6lUQ1N9tBe1BwhuLHlqzpp5T7Ja9/TFREignbZUa9+KK5+N+SeK9bbsijOfABrWqPtum";

/** Bridge public URL as configured (uppercase host + FQDN dot on purpose). */
const HOST_URL = "https://Bridge.Example.COM./";

/** Access subject from a (fictional) verified Cloudflare Access assertion. */
const ACCESS_SUBJECT = "user@example.com";

/** Canonical lowercase UUID. */
const CHALLENGE_ID = "4b3d0fd9-765d-4065-be00-6fc7ff075b05";

/** 32 random bytes, fixed at generation time (hex). */
const CHALLENGE_RAW_HEX = "4da015cb3bcdb1f193949c49dd45e31e1c3e494646dd1bc847f0588642af383c";

// -----------------------------------------------------------------------------
// Fixture construction.
// -----------------------------------------------------------------------------

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function u16be(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

function u32be(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

/** IDNA ToASCII + lowercase + no trailing dot (spec §10.3). */
function toHostAscii(urlInput: string): string {
  const url = new URL(urlInput);
  if (url.protocol !== "https:" || url.port !== "" || url.pathname !== "/") {
    throw new Error(`fixture host URL must be https with empty-or-/ path and empty-or-443 port: ${urlInput}`);
  }
  const ascii = domainToASCII(url.hostname);
  return ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
}

const privateKey = createPrivateKey({
  key: Buffer.from(FIXTURE_PRIVATE_KEY_PKCS8_B64, "base64"),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);
const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
const deviceId = b64u(createHash("sha256").update(spkiDer).digest());

const hostAscii = toHostAscii(HOST_URL);
const challengeRaw = Buffer.from(CHALLENGE_RAW_HEX, "hex");
if (challengeRaw.length !== 32) throw new Error("CHALLENGE_RAW_HEX must be exactly 32 bytes");

// Signing content per spec §10.3 — constructed inline, independent of the
// Bridge implementation, so the fixture can catch a systematic bug in it.
const hostBytes = Buffer.from(hostAscii, "utf8");
const deviceBytes = Buffer.from(deviceId, "ascii");
const challengeIdBytes = Buffer.from(CHALLENGE_ID, "ascii");
const subjectBytes = Buffer.from(ACCESS_SUBJECT, "utf8");
const signingContent = Buffer.concat([
  Buffer.from("CLAUDE-REMOTE-DEVICE-AUTH-V1", "ascii"),
  Buffer.from([0x00]),
  u16be(hostBytes.length),
  hostBytes,
  u16be(deviceBytes.length),
  deviceBytes,
  u16be(challengeIdBytes.length),
  challengeIdBytes,
  u32be(subjectBytes.length),
  subjectBytes,
  challengeRaw,
]);

// Random-nonce ECDSA: a DIFFERENT valid signature on every run. That is fine —
// verification is deterministic; Android only needs to verify these bytes.
const signatureDer = sign("sha256", signingContent, { key: privateKey, dsaEncoding: "der" });

const fixture = {
  version: 1,
  description:
    "Shared device-auth signing fixture for the TypeScript Bridge and the Android app (spec 10.3). " +
    "Generated once by bridge/scripts/gen-auth-fixture.ts; NEVER regenerate — the signature depends " +
    "on the ECDSA nonce, so a rerun yields a different signature while both implementations may have " +
    "pinned this one. Both sides must construct the signing content from the fields below and verify " +
    "signatureDerB64u over exactly signingContentHex.",
  algorithm:
    "ECDSA P-256 (secp256r1) with SHA-256; signature is ASN.1 DER SEQUENCE(INTEGER r, INTEGER s); " +
    "transport encoding is unpadded base64url",
  signingContext: "CLAUDE-REMOTE-DEVICE-AUTH-V1",
  hostUrl: HOST_URL,
  hostAscii,
  accessSubject: ACCESS_SUBJECT,
  publicKeySpkiB64u: b64u(spkiDer),
  deviceId,
  challengeId: CHALLENGE_ID,
  challengeRawHex: CHALLENGE_RAW_HEX,
  challengeRawB64u: b64u(challengeRaw),
  signingContentHex: signingContent.toString("hex"),
  signatureDerB64u: b64u(signatureDer),
};

const outPath = join(import.meta.dirname, "..", "..", "contracts", "v1", "auth-signing-fixture.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

console.log(`wrote ${outPath}`);
console.log(`  deviceId        = ${deviceId}`);
console.log(`  hostAscii       = ${hostAscii}`);
console.log(`  content (hex)   = ${signingContent.toString("hex")}`);
console.log("Reminder: commit this file and never regenerate it.");

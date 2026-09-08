package dev.clauderemote.android.security

import java.net.IDN

/**
 * Canonical device-auth signing bytes and host normalization (spec §10.3).
 *
 * Byte-identical port of the reviewed TypeScript implementation
 * `bridge/src/auth/signing-bytes.ts`; the committed fixture
 * `contracts/v1/auth-signing-fixture.json` pins the exact layout and both
 * implementations' test suites assert against that same file.
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
 * normalized. This file is pure JVM: no I/O, no clock, no crypto.
 */

/** Domain-separation prefix of the signing content (§10.3). */
const val SIGNING_CONTEXT = "CLAUDE-REMOTE-DEVICE-AUTH-V1"

/** Thrown when a host/URL input cannot be normalized to a canonical host. */
class InvalidHostException(message: String) : Exception(message)

/** Thrown when the fields of the signing content are malformed. */
class SigningInputError(message: String) : Exception(message)

/**
 * Normalizes the Bridge public URL (or a bare canonical host) to the exact
 * `hostAscii` string used in signatures (§10.3):
 *
 * - scheme must be `https` (a bare hostname without scheme is also accepted,
 *   matching the stored canonical form);
 * - no userinfo, query, or fragment;
 * - path must be empty or `/`;
 * - port must be empty or `443`;
 * - hostname is IDNA ToASCII'd, lowercased, and stripped of its trailing dot;
 * - the scheme, path, and `:443` never appear in the signed host.
 *
 * URL parsing mirrors the WHATWG parser the TypeScript implementation uses
 * for the checks above, but is deliberately stricter on two pathological
 * shapes WHATWG silently normalizes: percent-encoded host characters and
 * dot-segment paths (`/.`). Neither can produce a canonical host the two
 * implementations would agree on anyway, so they are rejected instead.
 */
fun normalizeHost(input: String): String {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) {
        throw InvalidHostException("host input is empty")
    }

    val hostname = SCHEME_PREFIX.find(trimmed)?.let { match ->
        val scheme = match.value.dropLast(1).lowercase()
        if (scheme != "https") {
            throw InvalidHostException("host URL scheme must be https: \"$trimmed\"")
        }
        parseHttpsAuthority(trimmed.substring(match.value.length), trimmed)
    } ?: run {
        if (URL_DELIMITERS.containsMatchIn(trimmed)) {
            throw InvalidHostException("bare host must not contain URL delimiters: \"$trimmed\"")
        }
        trimmed
    }

    return toCanonicalAsciiHost(hostname, input)
}

/**
 * Parses everything after the `https:` scheme prefix and returns the raw
 * hostname (still mixed-case, possibly with a trailing root dot, possibly a
 * bracketed IP literal which later LDH validation rejects).
 */
private fun parseHttpsAuthority(afterScheme: String, originalInput: String): String {
    // WHATWG "special authority ignore slashes": for https any run of
    // forward/back slashes after the scheme is skipped before the authority.
    var authorityStart = 0
    while (authorityStart < afterScheme.length &&
        (afterScheme[authorityStart] == '/' || afterScheme[authorityStart] == '\\')
    ) {
        authorityStart++
    }
    val terminatorIdx = afterScheme.indexOfAny(AUTHORITY_TERMINATORS, authorityStart)
    val authorityEnd = if (terminatorIdx < 0) afterScheme.length else terminatorIdx
    val authority = afterScheme.substring(authorityStart, authorityEnd)

    // Userinfo runs up to the LAST '@' in the authority (WHATWG).
    if (authority.lastIndexOf('@') >= 0) {
        throw InvalidHostException("host URL must not contain userinfo: \"$originalInput\"")
    }

    // host[:port] — bracketed IP literals keep their brackets (rejected later
    // by LDH label validation, mirroring domainToASCII's undefined result).
    var host: String
    var portStr: String? = null
    if (authority.startsWith("[")) {
        val close = authority.indexOf(']')
        if (close < 0) {
            throw InvalidHostException("host input is not a valid URL: \"$originalInput\"")
        }
        host = authority.substring(0, close + 1)
        val afterBracket = authority.substring(close + 1)
        if (afterBracket.isNotEmpty()) {
            if (!afterBracket.startsWith(":")) {
                throw InvalidHostException("host input is not a valid URL: \"$originalInput\"")
            }
            portStr = afterBracket.substring(1)
        }
    } else {
        val colon = authority.indexOf(':')
        if (colon >= 0) {
            host = authority.substring(0, colon)
            portStr = authority.substring(colon + 1)
            if (portStr.contains(':')) {
                // Unbracketed multi-colon host (bare IPv6): not a URL WHATWG accepts.
                throw InvalidHostException("host input is not a valid URL: \"$originalInput\"")
            }
        } else {
            host = authority
        }
    }

    if (!portStr.isNullOrEmpty()) {
        val port = portStr.toIntOrNull()
        if (port == null || port !in 0..65535) {
            throw InvalidHostException("host input is not a valid URL: \"$originalInput\"")
        }
        if (port != 443) {
            throw InvalidHostException("host URL port must be empty or 443: \"$originalInput\"")
        }
    }

    // Path/query/fragment validation over the remainder (which starts at the
    // delimiter that terminated the authority, if any).
    val remainder = afterScheme.substring(authorityEnd)
    val hashIdx = remainder.indexOf('#')
    val beforeHash = if (hashIdx < 0) remainder else remainder.substring(0, hashIdx)
    val queryIdx = beforeHash.indexOf('?')
    val pathPart = if (queryIdx < 0) beforeHash else beforeHash.substring(0, queryIdx)
    val queryPart = if (queryIdx < 0) "" else beforeHash.substring(queryIdx + 1)
    val fragmentPart = if (hashIdx < 0) "" else remainder.substring(hashIdx + 1)

    // A lone '?' or '#' is dropped by WHATWG; only real content is rejected.
    if (pathPart.isNotEmpty() && pathPart != "/" && pathPart != "\\") {
        throw InvalidHostException("host URL path must be empty or \"/\": \"$originalInput\"")
    }
    if (queryPart.isNotEmpty()) {
        throw InvalidHostException("host URL must not contain a query: \"$originalInput\"")
    }
    if (fragmentPart.isNotEmpty()) {
        throw InvalidHostException("host URL must not contain a fragment: \"$originalInput\"")
    }

    return host
}

/**
 * IDNA ToASCII + lowercase + no trailing dot (§10.3), with the same LDH
 * label validation the TypeScript applies on top of `domainToASCII`.
 */
private fun toCanonicalAsciiHost(hostname: String, originalInput: String): String {
    val lower = hostname.lowercase()
    // Pure-ASCII hosts pass through WHATWG's non-strict domainToASCII
    // unchanged, so java.net.IDN is only consulted for non-ASCII input
    // (where it provides the IDNA A-label conversion). This also avoids
    // IDN.toASCII's stricter per-label length rejection of already-ASCII
    // labels, keeping acceptance aligned with the TypeScript.
    val ascii = if (lower.all { it.code < 0x80 }) {
        lower
    } else {
        try {
            IDN.toASCII(lower)
        } catch (e: IllegalArgumentException) {
            throw InvalidHostException("hostname has no IDNA A-label form: \"$hostname\"")
        }
    }
    val withoutRootDot = if (ascii.endsWith(".")) ascii.dropLast(1) else ascii
    if (withoutRootDot.isEmpty()) {
        throw InvalidHostException("hostname is empty after normalization")
    }
    // IDNA ToASCII passes structurally invalid ASCII input (e.g. "a..b")
    // through unchanged, so empty and non-LDH labels are rejected here.
    for (label in withoutRootDot.split('.')) {
        if (!LDH_LABEL.matches(label)) {
            throw InvalidHostException(
                "hostname contains an invalid label (\"$label\") in \"$originalInput\"",
            )
        }
        if (label.length > MAX_LABEL_LENGTH) {
            throw InvalidHostException("hostname label exceeds $MAX_LABEL_LENGTH characters")
        }
    }
    if (withoutRootDot.length > MAX_HOSTNAME_LENGTH) {
        throw InvalidHostException("normalized hostname exceeds $MAX_HOSTNAME_LENGTH characters")
    }
    return withoutRootDot
}

/** Printable ASCII (no spaces, no control bytes) — required for host/device/challenge fields. */
private val PRINTABLE_ASCII = Regex("^[\\x21-\\x7e]+$")

/** `scheme:` prefix — anything matching is URL-parsed rather than treated as a bare host. */
private val SCHEME_PREFIX = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

/** Characters a bare canonical host must never contain. */
private val URL_DELIMITERS = Regex("[/@#?:]")

/** LDH label: letters/digits/hyphens, no leading or trailing hyphen. */
private val LDH_LABEL = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")

/** Characters that terminate an authority component (backslash included: https is a special scheme). */
private val AUTHORITY_TERMINATORS = charArrayOf('/', '?', '#', '\\')

private const val MAX_LABEL_LENGTH = 63
private const val MAX_HOSTNAME_LENGTH = 253

/** Encodes a printable-ASCII field, rejecting empty or non-printable input. */
private fun printableAsciiBytes(value: String, field: String): ByteArray {
    if (value.isEmpty()) {
        throw SigningInputError("$field must be a non-empty string")
    }
    if (!PRINTABLE_ASCII.matches(value)) {
        throw SigningInputError("$field must be printable ASCII")
    }
    return value.toByteArray(Charsets.US_ASCII)
}

private fun u16be(value: Int, field: String): ByteArray {
    if (value > 0xffff) {
        throw SigningInputError("$field exceeds the u16 length prefix")
    }
    return byteArrayOf((value ushr 8).toByte(), value.toByte())
}

private fun u32be(value: Int): ByteArray =
    byteArrayOf(
        (value ushr 24).toByte(),
        (value ushr 16).toByte(),
        (value ushr 8).toByte(),
        value.toByte(),
    )

/**
 * Builds the exact signing content for a device-auth signature (§10.3).
 * Throws [SigningInputError] on any malformed field so callers never sign
 * degenerate input.
 *
 * @param hostAscii canonical signed host (see [normalizeHost]).
 * @param deviceId base64url_no_pad(SHA-256(SPKI DER)) — ASCII by construction.
 * @param challengeId canonical lowercase UUID — ASCII by construction.
 * @param accessSubject Verified Access subject string, UTF-8 encoded
 *   verbatim (no Unicode normalization).
 * @param challengeRaw the 32-byte challenge, stored raw by the bridge for
 *   exact reconstruction.
 */
fun buildSigningBytes(
    hostAscii: String,
    deviceId: String,
    challengeId: String,
    accessSubject: String,
    challengeRaw: ByteArray,
): ByteArray {
    if (challengeRaw.size != 32) {
        throw SigningInputError(
            "challengeRaw must be exactly 32 bytes; got ${challengeRaw.size}",
        )
    }
    val hostBytes = printableAsciiBytes(hostAscii, "hostAscii")
    val deviceBytes = printableAsciiBytes(deviceId, "deviceId")
    val challengeIdBytes = printableAsciiBytes(challengeId, "challengeId")
    if (accessSubject.isEmpty()) {
        throw SigningInputError("accessSubject must be a non-empty string")
    }
    val subjectBytes = accessSubject.toByteArray(Charsets.UTF_8)
    if (subjectBytes.size.toLong() > 0xffffffffL) {
        throw SigningInputError("accessSubject exceeds the u32 length prefix")
    }

    return SIGNING_CONTEXT.toByteArray(Charsets.US_ASCII) +
        byteArrayOf(0x00) +
        u16be(hostBytes.size, "hostAscii") + hostBytes +
        u16be(deviceBytes.size, "deviceId") + deviceBytes +
        u16be(challengeIdBytes.size, "challengeId") + challengeIdBytes +
        u32be(subjectBytes.size) + subjectBytes +
        challengeRaw
}

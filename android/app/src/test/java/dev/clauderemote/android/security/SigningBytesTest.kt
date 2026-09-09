package dev.clauderemote.android.security

import java.io.File
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Canonical signing-bytes and host-normalization tests (spec §10.3), a 1:1
 * port of the TypeScript suite bridge/test/auth/signing-bytes.test.ts.
 *
 * The committed cross-implementation fixture
 * (contracts/v1/auth-signing-fixture.json) pins the exact byte layout; the
 * tests below compare the implementation output against the fixture hex AND
 * against an independently hand-constructed buffer, so a systematic bug in
 * the implementation cannot be masked by a fixture generated through the
 * same code path.
 *
 * The fixture is read straight from the repository (NOT copied into test
 * resources) so the TypeScript Bridge and this suite can never drift apart.
 * Gradle unit tests run with the module directory (android/app) as the
 * working directory; a repo-root fallback covers running from the root.
 */
class SigningBytesTest {

    // -------------------------------------------------------------------
    // Fixture access
    // -------------------------------------------------------------------

    private val fixture: Map<String, String> by lazy {
        val file = listOf(
            File("../../contracts/v1/auth-signing-fixture.json"), // CWD = android/app
            File("contracts/v1/auth-signing-fixture.json"), // CWD = repo root
        ).firstOrNull { it.isFile }
            ?: error(
                "contracts/v1/auth-signing-fixture.json not found " +
                    "(cwd=${System.getProperty("user.dir")})",
            )
        Json.parseToJsonElement(file.readText()).jsonObject
            .mapValues { (_, value) -> value.jsonPrimitive.content }
    }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

    private fun b64uDecode(text: String): ByteArray = Base64.getUrlDecoder().decode(text)

    private fun readU16be(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 0xff) shl 8) or (bytes[offset + 1].toInt() and 0xff)

    private fun readU32be(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 0xff) shl 24) or
            ((bytes[offset + 1].toInt() and 0xff) shl 16) or
            ((bytes[offset + 2].toInt() and 0xff) shl 8) or
            (bytes[offset + 3].toInt() and 0xff)

    private fun assertInvalidHost(input: String) {
        try {
            normalizeHost(input)
            fail("expected InvalidHostException for \"$input\"")
        } catch (expected: InvalidHostException) {
            // rejected, as required
        }
    }

    // -------------------------------------------------------------------
    // normalizeHost
    // -------------------------------------------------------------------

    @Test
    fun normalizeHostLowercasesStripsRootDotAndDropsDefaultPort() {
        assertEquals("bridge.example.com", normalizeHost("https://Bridge.Example.COM./"))
        assertEquals("example.com", normalizeHost("https://example.com:443/"))
        assertEquals("example.com", normalizeHost("https://example.com"))
    }

    @Test
    fun normalizeHostPerformsIdnaToAsciiOnUnicodeHostnames() {
        assertEquals("xn--r8jz45g.jp", normalizeHost("https://例え.jp/"))
    }

    @Test
    fun normalizeHostSharpSIsAKnownDivergenceFromTheBridgeUts46Normalizer() {
        // KNOWN, ACCEPTED DIVERGENCE from the TypeScript bridge normalizer —
        // the reason §10.3 has the challenge response carry the
        // bridge-canonical hostAscii that Android must use verbatim.
        // java.net.IDN implements IDNA2003, which maps ß -> ss, so this
        // implementation yields "strasse.de", while the bridge's WHATWG
        // UTS46 nontransitional processing keeps ß and yields
        // "xn--strae-oqa.de". Both are correct per their own standards;
        // production signing therefore never derives hostAscii locally.
        assertEquals("strasse.de", normalizeHost("https://straße.de/"))
        // The bridge value differs: domainToASCII("straße.de") === "xn--strae-oqa.de".
    }

    @Test
    fun normalizeHostAcceptsBareCanonicalHostname() {
        // The already-normalized storage form (no scheme) round-trips.
        assertEquals("bridge.example.com", normalizeHost("bridge.example.com"))
    }

    @Test
    fun normalizeHostRejectsNonHttpsSchemes() {
        assertInvalidHost("http://example.com/")
        assertInvalidHost("ws://example.com/")
        assertInvalidHost("example.com:8443") // parsed as a bogus scheme
    }

    @Test
    fun normalizeHostRejectsUserinfo() {
        assertInvalidHost("https://user:pass@example.com/")
        assertInvalidHost("https://user@example.com/")
    }

    @Test
    fun normalizeHostRejectsQueryStringsAndFragments() {
        assertInvalidHost("https://example.com/?q=1")
        assertInvalidHost("https://example.com/#section")
    }

    @Test
    fun normalizeHostRejectsNonRootPath() {
        assertInvalidHost("https://example.com/app")
        assertInvalidHost("https://example.com/app/")
    }

    @Test
    fun normalizeHostRejectsPortsOtherThanEmptyOr443() {
        assertInvalidHost("https://example.com:8443/")
        assertInvalidHost("https://example.com:80/")
    }

    @Test
    fun normalizeHostRejectsEmptyWhitespaceAndStructurallyInvalidHosts() {
        assertInvalidHost("")
        assertInvalidHost("   ")
        assertInvalidHost("https://..../") // empty labels
        assertInvalidHost("a..b") // IDNA ToASCII passes this through unchanged
        assertInvalidHost("https://example.com../") // double trailing dot
        assertInvalidHost("https://[2606:4700::6810:85e5]/") // IPv6 literal
        assertInvalidHost("/just/a/path")
    }

    // -------------------------------------------------------------------
    // buildSigningBytes
    // -------------------------------------------------------------------

    @Test
    fun buildSigningBytesEqualsCommittedFixtureByteForByte() {
        val bytes = buildSigningBytes(
            hostAscii = fixture.getValue("hostAscii"),
            deviceId = fixture.getValue("deviceId"),
            challengeId = fixture.getValue("challengeId"),
            accessSubject = fixture.getValue("accessSubject"),
            challengeRaw = hexToBytes(fixture.getValue("challengeRawHex")),
        )
        assertTrue(bytes.contentEquals(hexToBytes(fixture.getValue("signingContentHex"))))
    }

    @Test
    fun buildSigningBytesMatchesIndependentHandConstruction() {
        val hostBytes = fixture.getValue("hostAscii").toByteArray(Charsets.UTF_8)
        val deviceBytes = fixture.getValue("deviceId").toByteArray(Charsets.US_ASCII)
        val challengeIdBytes = fixture.getValue("challengeId").toByteArray(Charsets.US_ASCII)
        val subjectBytes = fixture.getValue("accessSubject").toByteArray(Charsets.UTF_8)
        val challengeRaw = hexToBytes(fixture.getValue("challengeRawHex"))

        fun u16(v: Int) = byteArrayOf((v ushr 8).toByte(), v.toByte())
        fun u32(v: Int) =
            byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte())

        val expected =
            SIGNING_CONTEXT.toByteArray(Charsets.US_ASCII) +
                byteArrayOf(0x00) +
                u16(hostBytes.size) + hostBytes +
                u16(deviceBytes.size) + deviceBytes +
                u16(challengeIdBytes.size) + challengeIdBytes +
                u32(subjectBytes.size) + subjectBytes +
                challengeRaw

        val bytes = buildSigningBytes(
            hostAscii = fixture.getValue("hostAscii"),
            deviceId = fixture.getValue("deviceId"),
            challengeId = fixture.getValue("challengeId"),
            accessSubject = fixture.getValue("accessSubject"),
            challengeRaw = challengeRaw,
        )
        assertTrue(bytes.contentEquals(expected))
    }

    @Test
    fun buildSigningBytesEncodesNonAsciiSubjectAsRawUtf8WithoutNormalization() {
        // Precomposed ü (U+00FC) plus a combining dot above (U+0307): NFC
        // folding must NOT occur, and the length prefix counts UTF-8 BYTES
        // (7), not UTF-16 code units (5).
        val subject = "ü̇ser"
        val subjectBytes = subject.toByteArray(Charsets.UTF_8)
        assertEquals(7, subjectBytes.size)

        val bytes = buildSigningBytes(
            hostAscii = "bridge.example.com",
            deviceId = "d",
            challengeId = "c",
            accessSubject = subject,
            challengeRaw = ByteArray(32) { 0xab.toByte() },
        )
        // The u32be length prefix sits immediately before the subject bytes,
        // which sit immediately before the 32-byte challengeRaw.
        val prefixStart = bytes.size - 32 - subjectBytes.size - 4
        assertEquals(subjectBytes.size, readU32be(bytes, prefixStart))
        assertTrue(
            bytes.copyOfRange(prefixStart + 4, bytes.size - 32).contentEquals(subjectBytes),
        )
        assertTrue(
            bytes.copyOfRange(bytes.size - 32, bytes.size)
                .contentEquals(ByteArray(32) { 0xab.toByte() }),
        )
    }

    @Test
    fun buildSigningBytesRejectsChallengeRawThatIsNotExactly32Bytes() {
        val hostAscii = "bridge.example.com"
        val deviceId = "dev"
        val challengeId = "chal"
        val accessSubject = "user@example.com"
        for (length in intArrayOf(31, 33, 0)) {
            try {
                buildSigningBytes(hostAscii, deviceId, challengeId, accessSubject, ByteArray(length))
                fail("expected SigningInputError for challengeRaw length $length")
            } catch (expected: SigningInputError) {
                // rejected, as required
            }
        }
    }

    @Test
    fun buildSigningBytesRejectsEmptyAndNonAsciiFields() {
        val challengeRaw = ByteArray(32)

        // Empty host/device/challengeId/subject are all rejected.
        assertSigningInputError("") { host -> buildSigningBytes(host, "dev", "chal", "s", challengeRaw) }
        assertSigningInputError("") { device -> buildSigningBytes("bridge.example.com", device, "chal", "s", challengeRaw) }
        assertSigningInputError("") { challenge -> buildSigningBytes("bridge.example.com", "dev", challenge, "s", challengeRaw) }
        assertSigningInputError("") { subject -> buildSigningBytes("bridge.example.com", "dev", "chal", subject, challengeRaw) }
        // Non-printable-ASCII device/challenge fields are rejected.
        assertSigningInputError("düv") { device -> buildSigningBytes("bridge.example.com", device, "chal", "s", challengeRaw) }
        assertSigningInputError("cål") { challenge -> buildSigningBytes("bridge.example.com", "dev", challenge, "s", challengeRaw) }
    }

    private fun assertSigningInputError(badValue: String, build: (String) -> ByteArray) {
        try {
            build(badValue)
            fail("expected SigningInputError for field value \"$badValue\"")
        } catch (expected: SigningInputError) {
            // rejected, as required
        }
    }

    @Test
    fun buildSigningBytesEnforcesU16HostLengthPrefix() {
        val max = buildSigningBytes(
            hostAscii = "a".repeat(0xffff),
            deviceId = "dev",
            challengeId = "chal",
            accessSubject = "s",
            challengeRaw = ByteArray(32),
        )
        assertEquals(0xffff, readU16be(max, SIGNING_CONTEXT.length + 1))

        assertSigningInputError("a".repeat(0x10000)) { host ->
            buildSigningBytes(host, "dev", "chal", "s", ByteArray(32))
        }
    }

    // -------------------------------------------------------------------
    // Fixture cross-checks (mirror the TypeScript suite)
    // -------------------------------------------------------------------

    @Test
    fun fixtureDeviceIdIsBase64urlNoPadSha256OfSpki() {
        val spki = b64uDecode(fixture.getValue("publicKeySpkiB64u"))
        val expected =
            Base64.getUrlEncoder().withoutPadding()
                .encodeToString(MessageDigest.getInstance("SHA-256").digest(spki))
        assertEquals(fixture.getValue("deviceId"), expected)
    }

    @Test
    fun fixtureSignatureVerifiesOverImplementationBuiltBytes() {
        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(b64uDecode(fixture.getValue("publicKeySpkiB64u"))))
        val bytes = buildSigningBytes(
            hostAscii = fixture.getValue("hostAscii"),
            deviceId = fixture.getValue("deviceId"),
            challengeId = fixture.getValue("challengeId"),
            accessSubject = fixture.getValue("accessSubject"),
            challengeRaw = hexToBytes(fixture.getValue("challengeRawHex")),
        )
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(bytes)
        assertTrue(verifier.verify(b64uDecode(fixture.getValue("signatureDerB64u"))))
    }
}

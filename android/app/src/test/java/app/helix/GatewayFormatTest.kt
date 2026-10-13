package app.helix

import app.helix.gateway.SigningFormat
import app.helix.model.CallStatus
import app.helix.model.DurationText
import app.helix.model.GatewayEvent
import app.helix.model.RelativeTime
import app.helix.model.Severity
import app.helix.model.WatchDTO
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayFormatTest {
    // MARK: Request signing (the same vectors as the iPhone's DeviceSignerTests and the gateway's device-signing.ts)

    @Test fun signingStringHasSevenLinesInOrder() {
        val text = SigningFormat.signingString("post", "/v1/sessions?x=1", "1791612728679", "abcdefghijklmnop", "hash", "dev1")
        assertEquals("HELIX-SIGN-V1\nPOST\n/v1/sessions?x=1\n1791612728679\nabcdefghijklmnop\nhash\ndev1", text)
    }

    @Test fun emptyBodyHashMatchesTheGatewayConstant() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", SigningFormat.sha256Hex(ByteArray(0)))
    }

    @Test fun nonceIsSixteenUrlSafeCharactersAndNeverRepeats() {
        val nonces = (1..200).map { SigningFormat.makeNonce() }
        assertTrue(nonces.all { Regex("^[A-Za-z0-9_-]{16}$").matches(it) })
        assertEquals(200, nonces.toSet().size)
    }

    /** What the Keystore produces (ECDSA P-256, SHA-256, DER) verifies against the public key, as the gateway checks it. */
    @Test fun aP256DerSignatureOfTheSigningStringVerifies() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val text = SigningFormat.signingString("GET", "/v1/ws", "1", SigningFormat.makeNonce(), SigningFormat.sha256Hex(ByteArray(0)), "d")
        val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private); update(text.toByteArray()) }.sign()
        val ok = Signature.getInstance("SHA256withECDSA").apply { initVerify(pair.public); update(text.toByteArray()) }.verify(signature)
        assertTrue(ok)
    }

    // MARK: Events

    @Test fun deviceNotificationDecodes() {
        val event = GatewayEvent.decode("""{"type":"device.notification","notification":{"title":"Build failed","body":"tsc: 3 errors","severity":"important","kind":"approval","approvalId":"a1"}}""")
        val n = (event as GatewayEvent.DeviceNotification).notification
        assertEquals("Build failed", n.title)
        assertEquals(Severity.Important, n.severity)
        assertEquals("a1", n.approvalId)
    }

    @Test fun callRingingDecodesWithTheFieldsTheRingNeeds() {
        val event = GatewayEvent.decode(
            """{"type":"call.ringing","call":{"id":"c1","direction":"incoming","status":"ringing","severity":"critical","title":"Training crashed","summary":"OOM","script":"","expects":"conversation","createdAt":"2026-10-12T12:34:56.789Z","extra":1}}""",
        )
        val call = (event as GatewayEvent.CallRinging).call
        assertEquals("c1", call.id)
        assertEquals(CallStatus.Ringing, call.status)
        assertEquals(Instant.parse("2026-10-12T12:34:56.789Z"), call.createdAt)
    }

    @Test fun unknownOrBrokenEventsNeverThrow() {
        assertEquals(GatewayEvent.Unknown("watch.triggered"), GatewayEvent.decode("""{"type":"watch.triggered","watch":{}}"""))
        assertEquals(GatewayEvent.Unknown("call.ringing"), GatewayEvent.decode("""{"type":"call.ringing"}"""))
        assertEquals(null, GatewayEvent.decode("not json"))
        assertEquals(GatewayEvent.Pong, GatewayEvent.decode("""{"type":"pong"}"""))
    }

    // MARK: Formatting (the iPhone's TimeFormatting)

    @Test fun relativeTimeReadsLikeTheIPhone() {
        val now = Instant.parse("2026-10-12T12:00:00Z")
        assertEquals("now", RelativeTime.short(now.minusSeconds(30), now))
        assertEquals("8m ago", RelativeTime.short(now.minusSeconds(8 * 60), now))
        assertEquals("2h 14m ago", RelativeTime.short(now.minusSeconds(2 * 3600 + 14 * 60), now))
        assertEquals("6h ago", RelativeTime.short(now.minusSeconds(6 * 3600), now))
        assertEquals("yesterday", RelativeTime.short(now.minusSeconds(30 * 3600), now))
        assertEquals("3d ago", RelativeTime.short(now.minusSeconds(75 * 3600), now))
    }

    @Test fun durationsAndCallClock() {
        assertEquals("1h 24m", DurationText.short(84 * 60.0))
        assertEquals("45s", DurationText.short(45.0))
        assertEquals("0m", DurationText.short(-5.0))
        assertEquals("4:12", DurationText.clock(252.0))
        assertEquals("1:02:09", DurationText.clock(3729.0))
    }

    @Test fun watcherSummaries() {
        val base = WatchDTO("w", "Training", Severity.Critical, true, Instant.EPOCH)
        assertEquals("Needs attention", base.copy(lastStatus = "triggered").asWatcher.summary)
        assertEquals(Severity.Critical, base.copy(lastStatus = "triggered").asWatcher.severity)
        assertEquals(Severity.Info, base.copy(lastStatus = "ok").asWatcher.severity)
        assertEquals("Paused", base.copy(enabled = false).asWatcher.summary)
    }
}

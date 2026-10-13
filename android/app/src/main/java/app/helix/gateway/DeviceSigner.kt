package app.helix.gateway

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Device-key request signing (docs/DEVICE-SIGNING.md, gateway `device-signing.ts`). The private key lives in the Android
 * Keystore - in StrongBox (a separate secure chip) when the phone has one, otherwise the TEE - and never leaves it. The
 * gateway keeps the public half and, once it has one, refuses any request from this device that is not signed with it.
 *
 * Two aliases take turns so a new pairing can bring a fresh key while the old one is kept until pairing succeeds
 * (the iPhone saves and restores its key the same way).
 */
class DeviceSigner(context: Context) {
    private val prefs = context.getSharedPreferences("helix.signing", Context.MODE_PRIVATE)
    private val store: KeyStore get() = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private var alias: String?
        get() = prefs.getString("alias", null)?.takeIf { store.containsAlias(it) }
        set(value) { prefs.edit().putString("alias", value).apply() }

    val hasKey: Boolean get() = alias != null

    /** "StrongBox", "Hardware" (TEE) or null, for Settings. */
    var keyLocation: String?
        get() = prefs.getString("location", null)
        private set(value) { prefs.edit().putString("location", value).apply() }

    /** SPKI DER, base64 - what the gateway stores. */
    val publicKeyBase64: String? get() = alias?.let { a ->
        store.getCertificate(a)?.publicKey?.encoded?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    }

    /** Creates a key if there is none yet. */
    fun ensureKey(): Boolean {
        if (alias != null) return true
        alias = generate(ALIASES.first())
        return alias != null
    }

    /** A fresh key for a new pairing. Returns the previous alias, to pass to [restore] if pairing fails, or [commit]. */
    fun beginReplacement(): String? {
        val previous = alias
        val next = ALIASES.first { it != previous }
        runCatching { store.deleteEntry(next) }
        alias = generate(next)
        return previous
    }

    /** Pairing failed: put the previous key back. */
    fun restore(previous: String?) {
        val created = alias
        if (created != null && created != previous) runCatching { store.deleteEntry(created) }
        alias = previous
    }

    /** Pairing worked: the previous key is no longer needed. */
    fun commit(previous: String?) {
        if (previous != null && previous != alias) runCatching { store.deleteEntry(previous) }
    }

    fun forget() {
        ALIASES.forEach { runCatching { store.deleteEntry(it) } }
        prefs.edit().clear().apply()
    }

    /** Proof of holding the key: a signature of `"helix-enroll-v1\n" + publicKey`. */
    fun enrollmentProof(): String? {
        val pub = publicKeyBase64 ?: return null
        return sign(SigningFormat.ENROLL_PREFIX + pub)
    }

    /** The four `X-Helix-*` headers for a request, or empty when this device has no key yet or no id. */
    fun headers(method: String, target: String, body: ByteArray, deviceId: String?): Map<String, String> {
        if (deviceId == null || alias == null) return emptyMap()
        val timestamp = System.currentTimeMillis().toString()
        val nonce = SigningFormat.makeNonce()
        val bodyHash = SigningFormat.sha256Hex(body)
        val signature = sign(SigningFormat.signingString(method, target, timestamp, nonce, bodyHash, deviceId)) ?: return emptyMap()
        return mapOf(
            "X-Helix-Timestamp" to timestamp,
            "X-Helix-Nonce" to nonce,
            "X-Helix-Body-SHA256" to bodyHash,
            "X-Helix-Signature" to signature,
        )
    }

    /** ECDSA P-256 with SHA-256; the Keystore returns DER, which the gateway accepts as well as raw r||s. */
    private fun sign(text: String): String? {
        val key = alias?.let { store.getKey(it, null) as? PrivateKey } ?: return null
        return runCatching {
            val s = Signature.getInstance("SHA256withECDSA")
            s.initSign(key)
            s.update(text.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(s.sign(), Base64.NO_WRAP)
        }.getOrNull()
    }

    private fun generate(name: String): String? {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
            .build()

        for (strongBox in listOf(true, false)) {
            if (strongBox && Build.VERSION.SDK_INT < 28) continue
            try {
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).apply { initialize(spec(strongBox)) }.generateKeyPair()
                keyLocation = if (strongBox) "StrongBox" else "Hardware"
                return name
            } catch (e: Exception) {
                // No StrongBox on this phone (StrongBoxUnavailableException) or it refused: fall back to the TEE.
                if (!strongBox) return null
            }
        }
        return null
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        val ALIASES = listOf("helix.signing.a", "helix.signing.b")
    }
}

/** The signing format, shared with the gateway and the iPhone. Pure, so it is unit-tested on the JVM. */
object SigningFormat {
    const val ENROLL_PREFIX = "helix-enroll-v1\n"

    /** The seven lines that get signed. */
    fun signingString(method: String, target: String, timestamp: String, nonce: String, bodySHA256: String, deviceID: String): String =
        listOf("HELIX-SIGN-V1", method.uppercase(), target, timestamp, nonce, bodySHA256, deviceID).joinToString("\n")

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

    /** 12 random bytes as base64url: 16 characters, new for every request. */
    fun makeNonce(): String {
        val bytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

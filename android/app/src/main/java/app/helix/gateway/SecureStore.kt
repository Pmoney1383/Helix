package app.helix.gateway

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The few secrets this app keeps (the device token and id from pairing), encrypted with an AES key that lives in the
 * Android Keystore and never leaves it - the Keychain's role on the iPhone. Backups are off (`allowBackup="false"`), so a
 * token on a restored phone does not silently come back: that phone pairs again.
 */
class SecureStore(context: Context) {
    enum class Key { DeviceToken, DeviceId }

    private val prefs: SharedPreferences = context.getSharedPreferences("helix.secure", Context.MODE_PRIVATE)

    fun get(key: Key): String? {
        val stored = prefs.getString(key.name, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes, 0, 12))
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        }.getOrNull()
    }

    fun set(key: Key, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(key.name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    fun delete(key: Key) = prefs.edit().remove(key.name).apply()

    fun deleteAll() = Key.entries.forEach(::delete)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "helix.secure-store"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

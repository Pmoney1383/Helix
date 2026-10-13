package app.helix.gateway

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.helix.BuildConfig

/**
 * The app's connection to one PC gateway: where it is, and the bearer token pairing returned. The address is a plain
 * preference (not sensitive), the token and device id are in [SecureStore].
 */
class GatewaySession(context: Context) {
    private val prefs = context.getSharedPreferences("helix.gateway", Context.MODE_PRIVATE)
    val secure = SecureStore(context)
    val signer = DeviceSigner(context)

    var baseUrl: String by mutableStateOf(prefs.getString("baseUrl", null) ?: defaultBaseUrl)
        private set
    var deviceToken: String? by mutableStateOf(secure.get(SecureStore.Key.DeviceToken))
        private set
    var deviceId: String? by mutableStateOf(secure.get(SecureStore.Key.DeviceId))
        private set

    val isPaired: Boolean get() = deviceToken != null

    val host: String get() = runCatching { java.net.URI(baseUrl).host }.getOrNull() ?: baseUrl

    fun changeBaseUrl(url: String) {
        baseUrl = url.trimEnd('/')
        prefs.edit().putString("baseUrl", baseUrl).apply()
    }

    /** Called once pairing succeeds. */
    fun store(deviceId: String, token: String) {
        this.deviceId = deviceId
        this.deviceToken = token
        secure.set(SecureStore.Key.DeviceId, deviceId)
        secure.set(SecureStore.Key.DeviceToken, token)
    }

    fun forget() {
        deviceToken = null
        deviceId = null
        secure.deleteAll()
        signer.forget()
    }

    companion object {
        /** The gateway's Tailscale Serve address, pre-filled in the pairing sheet; from `helix.gatewayHost` in local.properties. */
        val defaultBaseUrl: String = BuildConfig.GATEWAY_HOST.trim().let { if (it.isEmpty()) "https://your-pc.your-tailnet.ts.net" else "https://$it" }
    }
}

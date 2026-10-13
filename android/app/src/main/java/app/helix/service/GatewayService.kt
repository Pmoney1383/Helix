package app.helix.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import app.helix.HelixApplication

/**
 * Keeps the live connection to the gateway open while the app is closed. Android has no equivalent of Apple push for a
 * self-hosted server without Google's cloud, so this foreground service is how alerts, approvals and incoming calls reach
 * the phone (`device.notification` and `call.ringing` on the WebSocket). It shows one quiet, low-priority notification.
 */
class GatewayService : Service() {
    private val store get() = (application as HelixApplication).store

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = this
        goForeground(inCall = false)
        store.startLiveSyncIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!store.isPaired) { stopSelf(); return START_NOT_STICKY }
        store.startLiveSyncIfNeeded()
        return START_STICKY
    }

    override fun onDestroy() {
        if (running === this) running = null
        super.onDestroy()
    }

    /** Updates the quiet notification ("Connected to my-pc" / "Reconnecting…"). */
    fun refresh() = goForeground(inCall = store.activeCall != null)

    /** During a call the service also holds the phone-call and microphone types, so the mic keeps working in the background. */
    fun goForeground(inCall: Boolean) {
        val notifier = (application as HelixApplication).notifier
        val text = if (store.gatewayOnline) "Connected to ${store.gateway.hostName}" else "Reconnecting to your PC…"
        val notification = notifier.connectionNotification(text)
        if (Build.VERSION.SDK_INT >= 29) {
            var type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
            if (inCall && Build.VERSION.SDK_INT >= 30) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
            }
            runCatching { startForeground(Notifier.CONNECTION_ID, notification, type) }
                .onFailure { runCatching { startForeground(Notifier.CONNECTION_ID, notification, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0) } }
        } else {
            startForeground(Notifier.CONNECTION_ID, notification)
        }
    }

    companion object {
        @Volatile var running: GatewayService? = null
            private set

        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, GatewayService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayService::class.java))
        }
    }
}

package app.helix.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.helix.HelixApplication

/** Reject on an approval notification, and Decline on the incoming-call ring. Both are safe without unlocking. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = (context.applicationContext as HelixApplication).store
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        when (intent.action) {
            REJECT -> {
                val pending = goAsync()
                store.rejectFromNotification(id) { pending.finish() }
            }
            DECLINE -> store.declineRinging()
        }
    }

    companion object {
        const val REJECT = "app.helix.REJECT"
        const val DECLINE = "app.helix.DECLINE"
        const val EXTRA_ID = "id"
    }
}

/** Restarts the background connection after a reboot or an app update, if this phone is paired. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = (context.applicationContext as HelixApplication).store
        if (store.isPaired) GatewayService.start(context)
    }
}

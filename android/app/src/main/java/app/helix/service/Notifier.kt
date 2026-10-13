package app.helix.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import app.helix.MainActivity
import app.helix.R
import app.helix.model.DeviceNotificationDTO
import app.helix.model.Severity

/**
 * Everything the phone shows outside the app: the quiet "connected" notification of the background service, alerts and
 * approvals from the gateway (`device.notification`, what an iPhone gets as an Apple push), and the incoming-call ring.
 */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun createChannels() {
        manager.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_CONNECTION, "Connection to your PC", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while Helix keeps the connection to your PC open, so alerts and calls can reach you."
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Finished jobs, failures and other updates from your agents."
            },
            NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "An agent wants to do something that cannot be undone."
            },
            NotificationChannel(CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Helix calling you about something urgent."
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build(),
                )
                enableVibration(true)
            },
        ))
    }

    fun connectionNotification(text: String): Notification =
        Notification.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_helix)
            .setContentTitle("Helix")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp(REQUEST_OPEN, null))
            .build()

    /** An alert or an approval from the gateway. Only a short preview is shown; the full text is in the app. */
    fun show(n: DeviceNotificationDTO) {
        val approval = n.kind == "approval" && n.approvalId != null
        val builder = Notification.Builder(context, if (approval) CHANNEL_APPROVALS else CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_helix)
            .setContentTitle(n.title.take(80))
            .setContentText(n.body.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(140).orEmpty())
            .setAutoCancel(true)
            .setCategory(if (approval) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .setContentIntent(openApp(n.hashCode(), openTarget(n)))
        if (n.severity == Severity.Critical) builder.setCategory(Notification.CATEGORY_ALARM)
        if (approval) {
            val id = n.approvalId!!
            // Approve opens the app so it can ask for the fingerprint or screen lock first; Reject is always safe.
            builder.addAction(Notification.Action.Builder(null, "Approve", openApp(id.hashCode(), "approve:$id")).build())
            builder.addAction(Notification.Action.Builder(null, "Reject", action(NotificationActionReceiver.REJECT, id)).build())
        }
        manager.notify(tagFor(n), 0, builder.build())
    }

    fun cancelApproval(approvalId: String) = manager.cancel("approval:$approvalId", 0)

    /** The incoming-call ring: full screen on a locked phone, a heads-up with Answer and Decline otherwise. */
    fun showIncomingCall(callId: String, caller: String, title: String) {
        val fullScreen = openApp(REQUEST_CALL, "incoming:$callId")
        val answer = openApp(REQUEST_ANSWER, "answer:$callId")
        val decline = action(NotificationActionReceiver.DECLINE, callId)
        val builder = Notification.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_helix)
            .setContentTitle(caller)
            .setContentText(title.ifEmpty { "Incoming call" })
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setStyle(Notification.CallStyle.forIncomingCall(Person.Builder().setName(caller).setImportant(true).build(), decline, answer))
        } else {
            builder.addAction(Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_stat_helix), "Decline", decline).build())
            builder.addAction(Notification.Action.Builder(Icon.createWithResource(context, R.drawable.ic_stat_helix), "Answer", answer).build())
        }
        manager.notify(TAG_CALL, 0, builder.build())
    }

    fun cancelIncomingCall() = manager.cancel(TAG_CALL, 0)

    private fun tagFor(n: DeviceNotificationDTO) = n.approvalId?.let { "approval:$it" } ?: "event:${n.eventId ?: n.title.hashCode()}"

    private fun openTarget(n: DeviceNotificationDTO) = when (n.kind) {
        "approval" -> "approvals"
        "missed_call" -> "calls"
        else -> "chats"
    }

    private fun openApp(request: Int, target: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .apply { target?.let { putExtra(EXTRA_OPEN, it) } }
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun action(action: String, id: String): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).setAction(action).putExtra(NotificationActionReceiver.EXTRA_ID, id)
        return PendingIntent.getBroadcast(context, (action + id).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    companion object {
        const val CHANNEL_CONNECTION = "connection"
        const val CHANNEL_ALERTS = "alerts"
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_CALLS = "calls"
        const val EXTRA_OPEN = "helix.open"
        const val CONNECTION_ID = 1
        private const val TAG_CALL = "call"
        private const val REQUEST_OPEN = 1
        private const val REQUEST_CALL = 2
        private const val REQUEST_ANSWER = 3
    }
}

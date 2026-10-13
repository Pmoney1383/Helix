package app.helix.call

import android.content.ComponentName
import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * Owns the call as Android's call system sees it (a self-managed Telecom call: car Bluetooth, headsets and the audio route
 * work like any calling app) and the voice loop behind it - the iPhone's CallAudioManager.swift with CallKit.
 * If Telecom refuses (some emulators and custom ROMs), the call still runs in the app on the voice-call audio path.
 */
class CallAudioManager(private val context: Context) {
    val voiceLoop = VoiceLoop(context)
    private val main = Handler(Looper.getMainLooper())
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val audio = context.getSystemService(AudioManager::class.java)
    private val account = PhoneAccountHandle(ComponentName(context, HelixConnectionService::class.java), "helix")

    /** The audio is up and listening: the moment to speak the greeting. */
    var onReadyToSpeak: (() -> Unit)? = null
    /** The call ended, from either side. */
    var onCallEnded: (() -> Unit)? = null
    /** The user answered a call the gateway rang; the argument is the gateway's call id. */
    var onIncomingAnswered: ((String) -> Unit)? = null
    /** The user declined (or the ring was ended) before answering; the gateway's call id. */
    var onIncomingDeclined: ((String) -> Unit)? = null
    /** Mute changed from anywhere: the in-app button, a headset or the car. */
    var onMuteChanged: ((Boolean) -> Unit)? = null
    /** The audio route or the routes available changed (for the Audio button). */
    var onRouteChanged: (() -> Unit)? = null
    /** Show the full-screen ring for an incoming call (the store posts the notification). */
    var onShowIncoming: ((gatewayCallId: String, caller: String) -> Unit)? = null
    var onIncomingGone: ((gatewayCallId: String) -> Unit)? = null

    /** A local id for the call in progress, like CallKit's UUID; null when there is none. */
    var activeCallId: String? = null
        private set
    private var ringingGatewayCallId: String? = null
    private var connection: HelixConnection? = null
    private var directMode = false

    init {
        instance = this
        runCatching {
            telecom.registerPhoneAccount(
                PhoneAccount.builder(account, "Helix")
                    .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                    .setSupportedUriSchemes(listOf("helix"))
                    .build(),
            )
        }.onFailure { Log.w(TAG, "could not register with Android's call system: $it") }
    }

    /** Starts the outgoing call right away (for the system call state); the gateway call is created in parallel. */
    fun startOutgoing(handle: String): String {
        val id = java.util.UUID.randomUUID().toString()
        activeCallId = id
        directMode = false
        val extras = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, account)
            putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply { putString(EXTRA_LOCAL_ID, id) })
        }
        val placed = runCatching {
            if (!telecom.isOutgoingCallPermitted(account)) error("not permitted now")
            telecom.placeCall(Uri.fromParts("helix", handle, null), extras)
        }
        if (placed.isFailure) {
            Log.w(TAG, "Telecom refused the call (${placed.exceptionOrNull()}); running it in the app")
            startDirect()
        }
        return id
    }

    /** The gateway rang: ring through Android's call system (a full-screen ring with Answer and Decline). */
    fun reportIncoming(gatewayCallId: String, caller: String) {
        if (activeCallId != null) return // one call at a time
        activeCallId = java.util.UUID.randomUUID().toString()
        ringingGatewayCallId = gatewayCallId
        directMode = false
        val extras = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, account)
            putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, Bundle().apply {
                putString(EXTRA_GATEWAY_ID, gatewayCallId); putString(EXTRA_CALLER, caller)
            })
        }
        val reported = runCatching {
            if (!telecom.isIncomingCallPermitted(account)) error("not permitted now")
            telecom.addNewIncomingCall(account, extras)
        }
        if (reported.isFailure) {
            Log.w(TAG, "Telecom refused the incoming call (${reported.exceptionOrNull()}); ringing in the app")
            directMode = true
            onShowIncoming?.invoke(gatewayCallId, caller)
        }
    }

    /** Answer or decline from the ring UI (notification buttons or the in-app screen). */
    fun answerRinging() {
        val c = connection
        if (c != null) c.onAnswer() else if (directMode) answeredDirect()
    }

    fun declineRinging() {
        val c = connection
        if (c != null) c.onReject() else if (directMode) {
            val id = ringingGatewayCallId
            reset()
            id?.let { onIncomingGone?.invoke(it); onIncomingDeclined?.invoke(it) }
        }
    }

    /** The gateway says a call we are still ringing for no longer matters. */
    fun dismissRinging(gatewayCallId: String, missed: Boolean) {
        if (ringingGatewayCallId != gatewayCallId) return
        ringingGatewayCallId = null
        onIncomingGone?.invoke(gatewayCallId)
        connection?.let {
            it.setDisconnected(DisconnectCause(if (missed) DisconnectCause.MISSED else DisconnectCause.REMOTE))
            it.destroy()
        }
        reset()
    }

    fun endCall() {
        if (activeCallId == null) return
        val c = connection
        if (c != null) c.onDisconnect() else finishLocally()
    }

    fun setMuted(muted: Boolean) {
        voiceLoop.isMuted = muted
        onMuteChanged?.invoke(muted)
    }

    fun speak(text: String) = voiceLoop.speak(text)

    // MARK: Audio route (the Audio button)

    enum class Route { Earpiece, Speaker, Bluetooth, Headset }

    val currentRoute: Route get() = connection?.callAudioState?.route?.let(::routeOf)
        ?: if (audio.isSpeakerphoneOn) Route.Speaker else Route.Earpiece

    val availableRoutes: List<Route> get() {
        val mask = connection?.callAudioState?.supportedRouteMask
            ?: (CallAudioState.ROUTE_EARPIECE or CallAudioState.ROUTE_SPEAKER)
        return listOf(
            CallAudioState.ROUTE_EARPIECE to Route.Earpiece, CallAudioState.ROUTE_WIRED_HEADSET to Route.Headset,
            CallAudioState.ROUTE_BLUETOOTH to Route.Bluetooth, CallAudioState.ROUTE_SPEAKER to Route.Speaker,
        ).filter { mask and it.first != 0 }.map { it.second }
    }

    fun setRoute(route: Route) {
        val c = connection
        if (c != null) {
            @Suppress("DEPRECATION")
            c.setAudioRoute(when (route) {
                Route.Earpiece -> CallAudioState.ROUTE_EARPIECE
                Route.Speaker -> CallAudioState.ROUTE_SPEAKER
                Route.Bluetooth -> CallAudioState.ROUTE_BLUETOOTH
                Route.Headset -> CallAudioState.ROUTE_WIRED_HEADSET
            })
        } else {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = route == Route.Speaker
            onRouteChanged?.invoke()
        }
    }

    private fun routeOf(r: Int) = when (r) {
        CallAudioState.ROUTE_SPEAKER -> Route.Speaker
        CallAudioState.ROUTE_BLUETOOTH -> Route.Bluetooth
        CallAudioState.ROUTE_WIRED_HEADSET -> Route.Headset
        else -> Route.Earpiece
    }

    // MARK: Connection callbacks (from HelixConnectionService)

    internal fun createOutgoing(): Connection {
        val c = HelixConnection(this, incoming = false)
        connection = c
        c.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED)
        c.audioModeIsVoip = true
        c.setActive()
        main.post { startVoice() }
        return c
    }

    internal fun createIncoming(extras: Bundle?): Connection {
        val c = HelixConnection(this, incoming = true)
        connection = c
        c.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED)
        c.audioModeIsVoip = true
        val caller = extras?.getString(EXTRA_CALLER) ?: "Claude"
        c.setAddress(Uri.fromParts("helix", caller, null), TelecomManager.PRESENTATION_ALLOWED)
        c.setCallerDisplayName(caller, TelecomManager.PRESENTATION_ALLOWED)
        c.setRinging()
        return c
    }

    internal fun connectionFailed() = main.post {
        Log.w(TAG, "Telecom could not create the connection; running the call in the app")
        if (ringingGatewayCallId != null) {
            directMode = true
            onShowIncoming?.invoke(ringingGatewayCallId!!, "Claude")
        } else startDirect()
    }.let { }

    internal fun showIncomingUi() = main.post { ringingGatewayCallId?.let { onShowIncoming?.invoke(it, "Claude") } }.let { }

    internal fun answered() = main.post {
        val id = ringingGatewayCallId ?: return@post
        ringingGatewayCallId = null
        onIncomingGone?.invoke(id)
        connection?.setActive()
        startVoice()
        onIncomingAnswered?.invoke(id)
    }.let { }

    internal fun rejected() = main.post {
        val id = ringingGatewayCallId
        ringingGatewayCallId = null
        connection?.let { it.setDisconnected(DisconnectCause(DisconnectCause.REJECTED)); it.destroy() }
        reset()
        id?.let { onIncomingGone?.invoke(it); onIncomingDeclined?.invoke(it) }
    }.let { }

    internal fun disconnected() = main.post {
        connection?.let { it.setDisconnected(DisconnectCause(DisconnectCause.LOCAL)); it.destroy() }
        finishLocally()
    }.let { }

    internal fun muteFromSystem(muted: Boolean) = main.post { setMuted(muted) }.let { }

    internal fun audioStateChanged() = main.post { onRouteChanged?.invoke() }.let { }

    // MARK: Direct mode (no Telecom)

    private fun startDirect() {
        directMode = true
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        main.post { startVoice() }
    }

    private fun answeredDirect() {
        val id = ringingGatewayCallId ?: return
        ringingGatewayCallId = null
        onIncomingGone?.invoke(id)
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        startVoice()
        onIncomingAnswered?.invoke(id)
    }

    private fun startVoice() {
        voiceLoop.start { onReadyToSpeak?.invoke() }
    }

    private fun finishLocally() {
        val declined = ringingGatewayCallId
        voiceLoop.stop()
        voiceLoop.isMuted = false
        onMuteChanged?.invoke(false)
        if (directMode) audio.mode = AudioManager.MODE_NORMAL
        reset()
        if (declined != null) { onIncomingGone?.invoke(declined); onIncomingDeclined?.invoke(declined) } else onCallEnded?.invoke()
    }

    private fun reset() {
        connection = null
        activeCallId = null
        ringingGatewayCallId = null
        directMode = false
    }

    companion object {
        private const val TAG = "CallAudioManager"
        const val EXTRA_LOCAL_ID = "helix.localId"
        const val EXTRA_GATEWAY_ID = "helix.gatewayCallId"
        const val EXTRA_CALLER = "helix.caller"
        /** The one manager, for the ConnectionService that Android starts on its own. */
        @Volatile var instance: CallAudioManager? = null
    }
}

/** One Helix call in Android's call system. Every callback is forwarded to the manager. */
internal class HelixConnection(private val manager: CallAudioManager, private val incoming: Boolean) : Connection() {
    override fun onShowIncomingCallUi() = manager.showIncomingUi()
    override fun onAnswer() = manager.answered()
    override fun onAnswer(videoState: Int) = manager.answered()
    override fun onReject() = manager.rejected()
    override fun onDisconnect() = manager.disconnected()
    override fun onAbort() = manager.disconnected()

    @Deprecated("Deprecated in Java")
    override fun onCallAudioStateChanged(state: CallAudioState?) {
        state?.let { manager.muteFromSystem(it.isMuted) }
        manager.audioStateChanged()
    }
}

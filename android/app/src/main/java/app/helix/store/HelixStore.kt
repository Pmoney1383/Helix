package app.helix.store

import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateSetOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import app.helix.auth.DeviceAuth
import app.helix.call.CallAudioManager
import app.helix.call.RingbackTone
import app.helix.call.SpokenApproval
import app.helix.gateway.GatewayClient
import app.helix.gateway.GatewayClient.ClientError
import app.helix.gateway.GatewaySession
import app.helix.gateway.GatewayWebSocket
import app.helix.model.ActiveCall
import app.helix.model.AgentMessageDTO
import app.helix.model.AgentSession
import app.helix.model.AgentSessionInfoDTO
import app.helix.model.Approval
import app.helix.model.ApprovalDTO
import app.helix.model.ApprovalStatus
import app.helix.model.Call
import app.helix.model.CallDirection
import app.helix.model.CallPhase
import app.helix.model.CallStatus
import app.helix.model.ChatMessage
import app.helix.model.Conversation
import app.helix.model.DeviceNotificationDTO
import app.helix.model.DurationText
import app.helix.model.FrontDoor
import app.helix.model.GatewayEvent
import app.helix.model.GatewayJson
import app.helix.model.GatewayStatus
import app.helix.model.HeroUpdate
import app.helix.model.ManagedSessionDTO
import app.helix.model.MessageSender
import app.helix.model.PCStatus
import app.helix.model.PCStatusResponse
import app.helix.model.PersonaSettings
import app.helix.model.PresenceMode
import app.helix.model.PresenceStatusDTO
import app.helix.model.Provider
import app.helix.model.RouteDTO
import app.helix.model.SampleData
import app.helix.model.Severity
import app.helix.model.TileIcon
import app.helix.model.TranscriptLine
import app.helix.model.Watcher
import app.helix.service.GatewayService
import app.helix.service.Notifier
import java.lang.ref.WeakReference
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

enum class AppTab { Home, Chats, Calls, Settings }

sealed interface HomeRoute {
    data object Status : HomeRoute
    data object Approvals : HomeRoute
    data class Conversation(val id: String) : HomeRoute
}

/** A call the gateway is ringing that has not been answered yet (the in-app ring screen). */
data class RingingCall(val callId: String, val caller: String, val title: String)

/**
 * App state and the live gateway connection; screens only talk to this type (the iPhone's HelixStore.swift, ported
 * function for function). Every property is Compose state and is only touched on the main thread.
 */
class HelixStore(private val context: Context, private val notifier: Notifier) {
    private val scope = MainScope()

    var selectedTab by mutableStateOf(AppTab.Home)
    /** A Home screen something outside the UI (a tapped notification) wants open. */
    var pendingHomeRoute by mutableStateOf<HomeRoute?>(null)
    var gateway by mutableStateOf(SampleData.gateway)
    var pc by mutableStateOf(SampleData.pc)
    var heroUpdate by mutableStateOf<HeroUpdate?>(SampleData.hero)
    var conversations by mutableStateOf(SampleData.conversations)
    var sessions by mutableStateOf(SampleData.sessions)
    var watchers by mutableStateOf(SampleData.watchers)
    var approvals by mutableStateOf(SampleData.approvals)
    var calls by mutableStateOf(SampleData.calls)
    var presence by mutableStateOf(PresenceMode.Auto)
    var presenceStatus by mutableStateOf<PresenceStatusDTO?>(null)
        private set
    var persona by mutableStateOf(SampleData.persona)
    var activeCall by mutableStateOf<ActiveCall?>(null)
    var ringing by mutableStateOf<RingingCall?>(null)
    val typingConversationIDs = mutableStateSetOf<String>()
    val loadingConversationIDs = mutableStateSetOf<String>()
    val sendingConversationIDs = mutableStateSetOf<String>()
    val chatErrors = mutableStateMapOf<String, String>()
    val chatNotices = mutableStateMapOf<String, String>()
    var sessionsError by mutableStateOf<String?>(null)
    var isLoadingSessions by mutableStateOf(false)
    /** Live PC numbers for the Status screen; null until the first fetch lands. */
    var pcReport by mutableStateOf<PCStatusResponse?>(null)
    var pcStatusError by mutableStateOf<String?>(null)
    var gatewayUptimeSec by mutableStateOf<Int?>(null)
    /** Device-key request signing: null until checked. `signingProblem` is set when this phone cannot sign as required. */
    var signingStatus by mutableStateOf<GatewayClient.SigningStatus?>(null)
    var signingProblem by mutableStateOf<String?>(null)
    val hasMoreHistory = mutableStateSetOf<String>()
    val streamingReplies = mutableStateMapOf<String, String>()

    /** Set when a send 409s as `heavy_session`; the draft is held here until the user picks fresh or continue. */
    data class HeavySessionPrompt(val conversationID: String, val text: String, val contextTokens: Int, val id: String = UUID.randomUUID().toString())
    var heavySessionPrompt by mutableStateOf<HeavySessionPrompt?>(null)

    val session = GatewaySession(context)
    private val defaults = context.getSharedPreferences("helix.store", Context.MODE_PRIVATE)
    private val adoptionKey get() = "chat.adoptions.${session.baseUrl}.${session.deviceId ?: "unpaired"}"
    var isPairing by mutableStateOf(false)
    var pairingErrorMessage by mutableStateOf<String?>(null)
    val client get() = GatewayClient(session)
    private var webSocket: GatewayWebSocket? = null
    /** Conversation id (== route id) -> the route backing it. */
    private val liveRoutes = HashMap<String, RouteDTO>()
    private val sessionSources = HashMap<String, AgentSessionInfoDTO>()
    private val adoptedSessions = HashMap<String, ManagedSessionDTO>()
    private val historyCursors = HashMap<String, Int?>()
    /** "Start Here" opens blank every visit: anything from before the recorded moment is filtered out. */
    private val historyCutoffs = HashMap<String, Instant>()
    private val openedConversations = HashSet<String>()
    private val pendingMessageIDs = HashMap<String, String>()
    private val awaitingUserMessageIDs = HashMap<String, String>()
    /** Backstop for `typingConversationIDs`; see [clearStaleTypingState]. */
    private val typingStartedAt = HashMap<String, Instant>()
    /** Gateway session id -> title, so approvals (which only carry a sessionId) can be named. */
    private val sessionTitlesByID = HashMap<String, String>()
    private var approvalsAreLive = false

    /** The screen in front, for the fingerprint prompt before approving. */
    var activity: WeakReference<FragmentActivity>? = null

    // MARK: Calls (real)

    val callAudio = CallAudioManager(context)
    /** The gateway's call id for the active call (distinct from `activeCall.id`, a local id). */
    private var activeCallID: String? = null
    /** The active call's own route, tracked in [liveRoutes] like a chat route. */
    private var activeCallRouteID: String? = null
    private var callAudioReady = false
    private var pendingCallScript: String? = null
    var callError by mutableStateOf<String?>(null)
    /** The call on screen was rung by the gateway rather than started by the user. */
    private var activeCallIsIncoming = false
    /** Set only on an answered `expects: "approval"` call. */
    private var spokenApproval: SpokenApproval? = null
    private var ringingTitle: String? = null
    /** PC-voice bookkeeping: sentences whose audio has not arrived yet, by turn, and turns that fell back to the phone's voice. */
    private val pcSentences = HashMap<String, MutableMap<Int, String>>()
    private val appleFallbackTurns = HashSet<String>()
    private var pendingGreetingClip: Deferred<ByteArray?>? = null

    /** The call screen can be minimised without ending the call. */
    var callScreenHidden by mutableStateOf(false)
    var isMuted by mutableStateOf(false)
        private set
    var audioRoute by mutableStateOf(CallAudioManager.Route.Earpiece)
        private set

    private var pendingRingbackMs: Int? = null
    private var ringbackActive = false
    private var ringbackGeneration = 0
    /** Set by `call.hangup`: the next reply is the goodbye; end the call once it has been spoken. */
    private var hangupAfterReply = false

    init {
        if (session.isPaired) {
            conversations = emptyList()
            sessions = emptyList()
            watchers = emptyList()
            defaults.getString(adoptionKey, null)?.let { saved ->
                runCatching { GatewayJson.decodeFromString(MapSerializer(String.serializer(), ManagedSessionDTO.serializer()), saved) }
                    .getOrNull()?.let(adoptedSessions::putAll)
            }
        }
        setUpCallAudio()
    }

    fun mute(muted: Boolean) {
        isMuted = muted
        callAudio.setMuted(muted)
    }

    fun routeAudio(route: CallAudioManager.Route) = callAudio.setRoute(route)
    val availableAudioRoutes: List<CallAudioManager.Route> get() = callAudio.availableRoutes

    /** Wired once, not per call: these check `activeCall` themselves. */
    private fun setUpCallAudio() {
        callAudio.onReadyToSpeak = { callAudioReady = true; beginCallSpeechIfReady() }
        callAudio.onMuteChanged = { isMuted = it }
        callAudio.onCallEnded = { finishActiveCall() }
        callAudio.onRouteChanged = { audioRoute = callAudio.currentRoute }
        callAudio.voiceLoop.onFinalUtterance = { sendActiveCallUtterance(it) }
        callAudio.voiceLoop.onBusyChanged = { busy ->
            if (activeCall != null) activeCall = activeCall?.copy(phase = if (busy) CallPhase.Speaking else CallPhase.Listening)
        }
        callAudio.onIncomingAnswered = { answerIncomingCall(it) }
        callAudio.onIncomingDeclined = { id ->
            ringingTitle = null
            ringing = null
            if (session.isPaired) scope.launch { runCatching { client.declineCall(id) } }
        }
        callAudio.onShowIncoming = { id, caller ->
            val title = ringingTitle.orEmpty()
            ringing = RingingCall(id, caller, title)
            notifier.showIncomingCall(id, caller, title)
        }
        callAudio.onIncomingGone = {
            if (ringing?.callId == it) ringing = null
            notifier.cancelIncomingCall()
        }
    }

    // MARK: Notifications (what an iPhone gets through Apple push)

    /** Where a tapped notification should take the user (`openFromNotification` on the iPhone). */
    fun open(target: String) {
        when {
            target == "approvals" -> { selectedTab = AppTab.Home; pendingHomeRoute = HomeRoute.Approvals; scope.launch { syncApprovals() } }
            target == "calls" -> selectedTab = AppTab.Calls
            target == "chats" -> selectedTab = AppTab.Chats
            target.startsWith("approve:") -> approveFromNotification(target.removePrefix("approve:"))
            target.startsWith("answer:") -> answerRinging()
            target.startsWith("incoming:") -> Unit // the ring screen is already showing
        }
    }

    /** Approve on a notification opens the app; approving still needs the fingerprint or screen lock. */
    private fun approveFromNotification(id: String) {
        val activity = activity?.get()
        if (!session.isPaired || activity == null) { selectedTab = AppTab.Home; pendingHomeRoute = HomeRoute.Approvals; return }
        scope.launch {
            if (!DeviceAuth.confirm(activity, "Approve this request")) {
                selectedTab = AppTab.Home
                pendingHomeRoute = HomeRoute.Approvals
                return@launch
            }
            runCatching { client.resolveApproval(id, approve = true) }.onSuccess(::applyApproval)
                .onFailure { Log.w(TAG, "approval from notification failed: $it") }
            notifier.cancelApproval(id)
        }
    }

    /** Reject on a notification: safe, so it is sent straight away. */
    fun rejectFromNotification(id: String, done: () -> Unit) {
        if (!session.isPaired) { done(); return }
        scope.launch {
            runCatching { client.resolveApproval(id, approve = false) }.onSuccess(::applyApproval)
            notifier.cancelApproval(id)
            done()
        }
    }

    private fun showNotification(n: DeviceNotificationDTO) = notifier.show(n)

    // MARK: Pairing

    val isPaired: Boolean get() = session.isPaired
    val gatewayOnline: Boolean get() = gateway.isOnline

    /** Called by the pairing sheet. On success the token is stored before this returns, and the gateway is checked. */
    suspend fun pair(code: String, deviceName: String, gatewayAddress: String) {
        pairingErrorMessage = null
        isPairing = true
        try {
            session.changeBaseUrl(gatewayAddress)
            val result = client.pair(code, deviceName)
            session.store(result.deviceId, result.token)
            refreshGatewayStatus()
            GatewayService.start(context)
        } catch (e: Exception) {
            pairingErrorMessage = e.message
        } finally {
            isPairing = false
        }
    }

    /** Makes sure this phone's Keystore key is enrolled with the gateway (once per device). */
    private suspend fun ensureSigning() {
        try {
            var status = client.signingStatus()
            if (!status.enrolled) {
                client.enrollSigningKey()
                status = client.signingStatus()
            }
            signingStatus = status
            signingProblem = null
        } catch (e: ClientError.Http) {
            signingProblem = when {
                e.status == 409 -> "This phone's signing key doesn't match the one the gateway has. Pair again."
                e.status == 401 && (e.serverMessage == "signature_required" || e.serverMessage == "bad_signature") ->
                    "The gateway wants signed requests and this phone has no matching key. Pair again."
                else -> signingProblem
            }
        } catch (_: Exception) {
            // Offline or an older gateway without the endpoint: leave the last known state.
        }
    }

    /** Updates `gateway` from a real `/health` call. Safe to call any time (unpaired just marks offline). */
    suspend fun refreshGatewayStatus() {
        gateway = gateway.copy(address = session.host)
        if (!session.isPaired) {
            gateway = gateway.copy(isOnline = false)
            return
        }
        try {
            val health = client.checkHealth()
            gateway = gateway.copy(isOnline = health.ok, hostName = health.name, lastHeartbeat = Instant.now())
            gatewayUptimeSec = health.uptimeSec
            ensureSigning() // before the WebSocket: a gateway that requires signing refuses an unsigned upgrade
            startLiveSyncIfNeeded()
        } catch (_: Exception) {
            gateway = gateway.copy(isOnline = false)
        }
        GatewayService.running?.refresh()
    }

    private var lastVoiceWarm = Instant.EPOCH

    /** Wakes the PC voice (it takes a while to load after a quiet spell); at most once a minute. */
    fun warmVoice() {
        if (!session.isPaired || Instant.now().epochSecond - lastVoiceWarm.epochSecond <= 60) return
        lastVoiceWarm = Instant.now()
        scope.launch { client.warmVoice() }
    }

    /** Everything the Status screen shows, refreshed together; each part fails on its own. */
    suspend fun refreshStatus() {
        refreshGatewayStatus()
        if (!session.isPaired) return
        val sessionsDone = scope.launch { syncAgentSessions() }
        try {
            pcReport = client.pcStatus()
            pcStatusError = null
        } catch (e: ClientError.Http) {
            pcStatusError = if (e.status == 404) "PC load isn't available from this gateway yet." else "Couldn't read the PC: ${e.message}"
        } catch (e: Exception) {
            pcStatusError = "Couldn't read the PC: ${e.message}"
        }
        runCatching { client.watches() }.getOrNull()?.let { list -> watchers = list.map { it.asWatcher }.sortedByDescending { it.lastEventAt } }
        sessionsDone.join()
    }

    // MARK: Live sync (sessions, routes, WebSocket)

    /** Connects the socket (idempotent) and syncs sessions, the two front doors, approvals and presence. */
    fun startLiveSyncIfNeeded() {
        if (!session.isPaired) return
        if (webSocket == null) {
            val socket = GatewayWebSocket(session, client)
            socket.onEvent = ::handle
            socket.onConnectionChange = { connected ->
                if (connected) {
                    gateway = gateway.copy(isOnline = true, lastHeartbeat = Instant.now())
                    scope.launch { openedConversations.toList().forEach { loadConversation(it) } }
                    scope.launch { syncApprovals() }
                }
                GatewayService.running?.refresh()
            }
            webSocket = socket
        }
        webSocket?.connect()
        webSocket?.nudge()
        if (sessionSources.isEmpty()) sessions = emptyList()
        conversations = conversations.filter { liveRoutes[it.id] != null || sessionSources[it.id] != null }
        scope.launch { syncAgentSessions() }
        scope.launch { ensureFrontDoorRoutes() }
        scope.launch { syncApprovals() }
        scope.launch { syncPresence() }
    }

    suspend fun syncPresence() {
        if (!session.isPaired) return
        runCatching { client.getPresence() }.getOrNull()?.let { status ->
            PresenceMode.fromWire(status.mode)?.let { presence = it }
            presenceStatus = status
        }
    }

    /** Settings' picker calls this directly, so a sync setting `presence` never fires a needless PUT. */
    fun changePresence(mode: PresenceMode) {
        presence = mode
        if (!session.isPaired) return
        scope.launch {
            runCatching { client.changePresence(mode) }.getOrNull()?.let { status ->
                PresenceMode.fromWire(status.mode)?.let { presence = it }
                presenceStatus = status
            }
        }
    }

    suspend fun syncAgentSessions() {
        if (!session.isPaired || isLoadingSessions) return
        isLoadingSessions = true
        sessionsError = null
        try {
            val infos = client.listAgentSessions(100)
            sessions = infos.map(::mapSession)
            for (info in infos) {
                sessionTitlesByID[info.id] = info.title
                registerSessionConversation(info)
            }
        } catch (e: Exception) {
            sessionsError = e.message
        } finally {
            isLoadingSessions = false
        }
    }

    /** Pending first (so a slow sync never hides what most needs seeing), then resolved history. */
    suspend fun syncApprovals() {
        if (!session.isPaired) return
        try {
            val pending = client.listApprovals(ApprovalStatus.Pending, 100)
            val resolved = client.listApprovals(null, 50)
            val byID = LinkedHashMap<String, ApprovalDTO>()
            (pending + resolved).forEach { byID.putIfAbsent(it.id, it) }
            approvals = byID.values.map(::mapApproval).sortedByDescending { it.createdAt }
            approvalsAreLive = true
        } catch (_: Exception) {
            // Transient failure: keep whatever approvals are already showing.
        }
    }

    private var frontDoorSync: Job? = null

    /**
     * One persistent "General Claude" and one "Astra" conversation, reused across launches. Single-flight: several things
     * start a sync at once on launch (pairing, the background service, the app coming to the front), and two overlapping
     * syncs would each find no route and create one.
     */
    suspend fun ensureFrontDoorRoutes() {
        if (!session.isPaired) return
        frontDoorSync?.takeIf { it.isActive }?.let { it.join(); return }
        val job = scope.launch { syncFrontDoors() }
        frontDoorSync = job
        job.join()
    }

    private suspend fun syncFrontDoors() {
        for (door in FrontDoor.entries) {
            try {
                val route = findOrCreateRoute(door)
                liveRoutes[route.id] = route
                syncConversation(route, door)
            } catch (e: Exception) {
                sessionsError = e.message
            }
        }
    }

    private suspend fun findOrCreateRoute(door: FrontDoor): RouteDTO =
        client.listRoutes().firstOrNull { it.frontDoor == door.provider } ?: client.createRoute(door.provider)

    private suspend fun syncConversation(route: RouteDTO, door: FrontDoor) {
        var messages = emptyList<ChatMessage>()
        try {
            messages = client.routeMessages(route.id).mapNotNull(::mapMessage)
            chatErrors.remove(route.id)
        } catch (e: Exception) {
            chatErrors[route.id] = e.message.orEmpty()
        }
        val conversation = Conversation(
            id = route.id, title = door.displayName, typeLabel = if (door == FrontDoor.Claude) "General Claude" else "Astra",
            icon = TileIcon.Brand(door.logo), provider = door.provider, frontDoor = door,
            lastActivityAt = messages.lastOrNull()?.createdAt ?: route.updatedAt, messages = messages,
        )
        if (conversations.any { it.id == route.id }) {
            mergeHistory(messages, route.id, older = false)
        } else {
            conversations = conversations.filter { it.frontDoor != door } + conversation
        }
    }

    /**
     * Every "Start Here" visit looks like a brand new conversation with the router: the display clears now, and the
     * server-side reset happens in the background (so "Claude" never silently answers as a session it was handed to).
     */
    fun resetFrontDoorConversation(id: String) {
        val c = conversation(id) ?: return
        if (c.frontDoor == null) return
        updateConversation(id) { it.copy(messages = emptyList()) }
        historyCutoffs[id] = Instant.now()
        if (!session.isPaired || liveRoutes[id] == null) return
        scope.launch { runCatching { client.resetRoute(id) }.getOrNull()?.let { liveRoutes[id] = it } }
    }

    fun sessionConversationID(s: AgentSession) = "session:${s.key}"

    private fun registerSessionConversation(info: AgentSessionInfoDTO) {
        val id = "session:${info.key}"
        sessionSources[id] = info
        val adopted = adoptedSessions[id]
        if (adopted != null && adopted.providerSessionId != info.id) {
            chatNotices[id] = "Continuing in a fork. The original desktop session is unchanged."
        }
        if (conversations.any { it.id == id }) {
            if (adopted == null) updateConversation(id) { it.copy(title = info.title) }
            return
        }
        conversations = conversations + Conversation(
            id = id, title = adopted?.title ?: info.title, typeLabel = info.projectName ?: "PC session",
            icon = TileIcon.Brand(if (info.provider == Provider.Claude) FrontDoor.Claude.logo else FrontDoor.Codex.logo),
            provider = info.provider, lastActivityAt = info.lastActivityAt ?: info.createdAt ?: Instant.EPOCH, messages = emptyList(),
        )
    }

    /** Viewing is read-only. Adoption is deferred until the first send. */
    suspend fun loadConversation(id: String, older: Boolean = false) {
        if (!session.isPaired || id in loadingConversationIDs) return
        openedConversations += id
        loadingConversationIDs += id
        chatErrors.remove(id)
        try {
            val source = sessionSources[id]
            val route = liveRoutes[id]
            var messages: MutableList<ChatMessage>
            if (source != null) {
                val providerID = adoptedSessions[id]?.providerSessionId ?: source.id
                val page = try {
                    client.sessionTranscript(source.provider, providerID, if (older) historyCursors[id] else null)
                } catch (e: ClientError.Http) {
                    if (e.status != 404) throw e
                    // Newly created threads can come before their transcript file is discovered.
                    val managedID = adoptedSessions[id]?.id ?: source.helixSessionId
                    if (older || managedID == null) throw ClientError.Http(404, "History is not available yet. Try refreshing.")
                    val wire = client.sessionMessages(managedID)
                    val baseline = conversation(id)?.messages?.filter { it.id.startsWith("transcript:") }.orEmpty()
                    mergeHistory(baseline + wire.mapNotNull(::mapMessage), id, older = false)
                    settleReply(wire, id)
                    return
                }
                if (page.hasMore) hasMoreHistory += id else hasMoreHistory -= id
                historyCursors[id] = page.messages.firstOrNull()?.index
                messages = page.messages.mapNotNull { m ->
                    if (m.role == "tool" || isInternalNoise(m.text)) null
                    else ChatMessage("transcript:$providerID:${m.index}", if (m.role == "user") MessageSender.User else MessageSender.Agent, m.text,
                        m.ts ?: source.createdAt ?: Instant.EPOCH)
                }.toMutableList()
                val managedID = adoptedSessions[id]?.id ?: source.helixSessionId
                if (!older && managedID != null) {
                    val wire = client.sessionMessages(managedID)
                    // Provider transcripts and the gateway ledger describe the same turn with different ids; prefer ledger ids.
                    for (message in wire) {
                        val mapped = mapMessage(message) ?: continue
                        val duplicate = messages.indexOfLast {
                            it.sender == message.sender && it.text == message.text && abs(it.createdAt.epochSecond - message.createdAt.epochSecond) < 10
                        }
                        if (duplicate >= 0) messages[duplicate] = mapped
                        else if (!message.createdAt.isBefore(messages.firstOrNull()?.createdAt ?: Instant.EPOCH)) messages += mapped
                    }
                    messages.sortBy { it.createdAt }
                    settleReply(wire, id)
                }
            } else if (route != null) {
                val wire = client.routeMessages(route.id)
                messages = wire.mapNotNull(::mapMessage).toMutableList()
                settleReply(wire, id)
            } else return
            mergeHistory(messages, id, older)
        } catch (e: Exception) {
            chatErrors[id] = e.message.orEmpty()
        } finally {
            loadingConversationIDs -= id
        }
    }

    private fun settleReply(messages: List<AgentMessageDTO>, id: String) {
        val userID = awaitingUserMessageIDs[id] ?: return
        val index = messages.indexOfFirst { it.id == userID }
        if (index < 0 || messages.drop(index + 1).none { it.sender == MessageSender.Agent || it.sender == MessageSender.System }) return
        clearTyping(id)
        awaitingUserMessageIDs.remove(id)
    }

    private fun mergeHistory(raw: List<ChatMessage>, id: String, older: Boolean) {
        val current = conversation(id) ?: return
        val messages = historyCutoffs[id]?.let { cutoff -> raw.filter { !it.createdAt.isBefore(cutoff) } } ?: raw
        val merged = if (older) {
            val existing = current.messages.map { it.id }.toSet()
            messages.filter { it.id !in existing } + current.messages
        } else {
            // Keep events received while the HTTP snapshot was in flight.
            val newest = messages.lastOrNull()?.createdAt ?: Instant.EPOCH
            val ids = messages.map { it.id }.toSet()
            messages + current.messages.filter { it.id !in ids && it.createdAt.isAfter(newest) && !it.id.startsWith("transcript:") }
        }
        updateConversation(id) { it.copy(messages = merged, lastActivityAt = merged.lastOrNull()?.createdAt ?: it.lastActivityAt) }
    }

    fun canSend(id: String): Boolean {
        clearStaleTypingState(id)
        return session.isPaired && (liveRoutes[id] != null || sessionSources[id] != null) &&
            id !in sendingConversationIDs && id !in typingConversationIDs && id !in loadingConversationIDs
    }

    /** Backstop: if no event ever clears "typing", give up after 90 s so the chat can send again. */
    private fun clearStaleTypingState(id: String) {
        val started = typingStartedAt[id] ?: return
        if (Instant.now().epochSecond - started.epochSecond <= 90) return
        clearTyping(id)
        awaitingUserMessageIDs.remove(id)
    }

    private fun clearTyping(id: String) {
        typingConversationIDs -= id
        streamingReplies.remove(id)
        typingStartedAt.remove(id)
    }

    // MARK: WebSocket events

    fun handle(event: GatewayEvent) {
        when (event) {
            is GatewayEvent.MessageCreated -> appendLiveMessage(event.message)
            is GatewayEvent.AgentOutputDelta -> for (id in conversationIDs(event.sessionId)) {
                typingConversationIDs += id
                typingStartedAt[id] = Instant.now()
                streamingReplies[id] = (streamingReplies[id] ?: "") + event.text
            }
            is GatewayEvent.AgentOutputFinal -> for (id in conversationIDs(event.sessionId)) {
                clearTyping(id)
                scope.launch { loadConversation(id) }
            }
            is GatewayEvent.RouteHandoff -> {
                val route = liveRoutes[event.routeId] ?: return
                liveRoutes[event.routeId] = route.copy(
                    targetSessionId = event.toSessionId, currentSessionId = event.toSessionId,
                    visited = if (event.toSessionId in route.visited) route.visited else route.visited + event.toSessionId,
                )
                // Show who is actually answering now, not the front door's fixed name.
                updateConversation(event.routeId) { it.copy(title = event.toTitle) }
                // The handoff resolves whatever turn was pending (a connect-only handoff may produce no further message).
                clearTyping(event.routeId)
                awaitingUserMessageIDs.remove(event.routeId)
                if (event.routeId == activeCallRouteID) activeCall = activeCall?.copy(title = event.toTitle)
            }
            is GatewayEvent.AgentSpeech -> {
                if (!isCallSession(event.sessionId)) return
                appendTranscript(TranscriptLine(MessageSender.Agent, event.text))
                if (event.engine == "pc" && event.turnId !in appleFallbackTurns) {
                    // The PC voice speaks this one: its audio follows as agent.audio. Stay quiet.
                    pcSentences.getOrPut(event.turnId) { mutableMapOf() }[event.seq] = event.text
                    callAudio.voiceLoop.setPCTurnActive(true)
                } else {
                    callAudio.speak(event.text)
                }
            }
            is GatewayEvent.AgentAudio -> {
                if (!isCallSession(event.sessionId) || event.turnId in appleFallbackTurns) return
                pcSentences[event.turnId]?.remove(event.seq)
                callAudio.voiceLoop.playPCM(event.pcm, event.sampleRate)
            }
            is GatewayEvent.AgentAudioEnd -> {
                if (!isCallSession(event.sessionId)) return
                pcSentences.remove(event.turnId)
                callAudio.voiceLoop.setPCTurnActive(false)
            }
            is GatewayEvent.AgentAudioUnavailable -> {
                if (!isCallSession(event.sessionId)) return
                // Say whatever has no audio yet with the phone's voice, and everything else this turn.
                appleFallbackTurns += event.turnId
                pcSentences[event.turnId]?.toSortedMap()?.values?.forEach(callAudio::speak)
                pcSentences.remove(event.turnId)
                callAudio.voiceLoop.setPCTurnActive(false)
            }
            is GatewayEvent.AgentSpeechEnd -> {
                val routeId = activeCallRouteID
                val inCall = activeCall != null && routeId != null && liveRoutes[routeId]?.visited?.contains(event.sessionId) == true
                val callID = activeCallID
                if (!event.cancelled && hangupAfterReply && callID != null && inCall) {
                    hangupAfterReply = false
                    scope.launch { hangUpWhenQuiet(callID, 30.0) }
                    return
                }
                if (!event.cancelled || !inCall) return
                callAudio.voiceLoop.stopSpeakingAndClearQueue()
                pcSentences.clear()
            }
            is GatewayEvent.AgentSessionChanged -> upsertSession(event.session)
            is GatewayEvent.CallRinging -> {
                // Android has no PushKit: the gateway rings this phone with this event on the live connection.
                val call = event.call
                if (call.direction == CallDirection.Incoming && call.status == CallStatus.Ringing && activeCall == null) {
                    ringingTitle = call.title
                    callAudio.reportIncoming(call.id, "Claude")
                }
            }
            is GatewayEvent.CallAnswered -> Unit // outgoing calls are already answered by the time this app sees them
            is GatewayEvent.CallEnded -> {
                // Still ringing: it no longer matters (answered elsewhere, missed, approval resolved).
                callAudio.dismissRinging(event.call.id, missed = event.call.status == CallStatus.Missed)
                if (event.call.id == activeCallID) callAudio.endCall()
            }
            is GatewayEvent.CallHangup -> if (event.call.id == activeCallID) hangupAfterReply = true
            is GatewayEvent.ApprovalRequested -> applyApproval(event.approval)
            is GatewayEvent.ApprovalResolved -> {
                applyApproval(event.approval)
                notifier.cancelApproval(event.approval.id)
            }
            is GatewayEvent.DeviceNotification -> showNotification(event.notification)
            is GatewayEvent.Hello, GatewayEvent.Pong, is GatewayEvent.Unknown -> Unit
        }
    }

    private fun isCallSession(sessionId: String): Boolean {
        val routeId = activeCallRouteID ?: return false
        return activeCall != null && liveRoutes[routeId]?.visited?.contains(sessionId) == true
    }

    /** Which live conversations a gateway session id belongs to (a route spans every session it visited). */
    private fun conversationIDs(sessionId: String): List<String> =
        liveRoutes.filter { sessionId in it.value.visited }.keys.toList() +
            sessionSources.filter { (adoptedSessions[it.key]?.id ?: it.value.helixSessionId) == sessionId }.keys

    private fun appendLiveMessage(wire: AgentMessageDTO) {
        for (id in conversationIDs(wire.conversationId)) {
            val cutoff = historyCutoffs[id]
            if (cutoff != null && wire.createdAt.isBefore(cutoff)) continue
            val c = conversation(id) ?: continue
            var messages = c.messages
            val pending = pendingMessageIDs[id]
            if (wire.sender == MessageSender.User && pending != null && messages.any { it.id == pending && it.text == wire.text }) {
                messages = messages.filter { it.id != pending }
            }
            mapMessage(wire)?.let { mapped -> if (messages.none { it.id == wire.id }) messages = messages + mapped }
            updateConversation(id) { it.copy(messages = messages, lastActivityAt = wire.createdAt) }
            if (wire.sender == MessageSender.Agent || wire.sender == MessageSender.System) clearTyping(id)
        }
    }

    private fun upsertSession(info: AgentSessionInfoDTO) {
        registerSessionConversation(info)
        sessionTitlesByID[info.id] = info.title
        val mapped = mapSession(info)
        sessions = if (sessions.any { it.key == info.key }) sessions.map { if (it.key == info.key) mapped else it } else listOf(mapped) + sessions
    }

    private fun applyApproval(dto: ApprovalDTO) {
        val mapped = mapApproval(dto)
        approvals = if (approvals.any { it.id == dto.id }) approvals.map { if (it.id == dto.id) mapped else it } else listOf(mapped) + approvals
    }

    // MARK: Wire -> UI mapping

    private fun mapSession(info: AgentSessionInfoDTO) = AgentSession(
        key = info.key, provider = info.provider, title = info.title, projectName = info.projectName,
        lastActivityAt = info.lastActivityAt ?: info.createdAt ?: Instant.EPOCH, live = info.live, liveStatus = info.liveStatus, managed = info.managed,
    )

    private fun mapMessage(wire: AgentMessageDTO): ChatMessage? =
        if (isInternalNoise(wire.text)) null else ChatMessage(wire.id, wire.sender, wire.text, wire.createdAt)

    private fun mapApproval(dto: ApprovalDTO) = Approval(
        id = dto.id, sessionTitle = dto.sessionId?.let { sessionTitlesByID[it] }, tool = dto.tool, summary = dto.summary,
        reasons = dto.reasons, status = dto.status, createdAt = dto.createdAt, expiresAt = dto.expiresAt, resolvedAt = dto.resolvedAt,
    )

    // MARK: Derived

    val pendingApprovals: List<Approval> get() = approvals.filter { it.status == ApprovalStatus.Pending }.sortedBy { it.expiresAt }
    val resolvedApprovals: List<Approval> get() = approvals.filter { it.status != ApprovalStatus.Pending }.sortedByDescending { it.resolvedAt ?: it.createdAt }
    val recentConversations: List<Conversation> get() = conversations.sortedByDescending { it.lastActivityAt }
    val frontDoorConversations: List<Conversation> get() = FrontDoor.entries.mapNotNull { door -> conversations.firstOrNull { it.frontDoor == door } }

    /** What the Chats list shows: every session chat, plus a front door only once it has something in it. */
    val visibleConversations: List<Conversation> get() =
        recentConversations.filter { it.frontDoor == null || it.messages.isNotEmpty() || it.id in typingConversationIDs }

    fun conversation(id: String): Conversation? = conversations.firstOrNull { it.id == id }

    private fun updateConversation(id: String, change: (Conversation) -> Conversation) {
        conversations = conversations.map { if (it.id == id) change(it) else it }
    }

    // MARK: Approvals

    /** Approving needs the fingerprint or screen lock, as on the iPhone. Rejecting never does. */
    fun approveWithAuth(id: String) {
        val activity = activity?.get() ?: return
        scope.launch { if (DeviceAuth.confirm(activity, "Approve this request")) approve(id) }
    }

    fun approve(id: String) = resolve(id, ApprovalStatus.Approved)
    fun reject(id: String) = resolve(id, ApprovalStatus.Rejected)

    private fun resolve(id: String, status: ApprovalStatus) {
        if (approvals.none { it.id == id && it.status == ApprovalStatus.Pending }) return
        // Update now so the tap feels instant; the real call corrects it if someone else already resolved it.
        approvals = approvals.map { if (it.id == id) it.copy(status = status, resolvedAt = Instant.now()) else it }
        notifier.cancelApproval(id)
        if (!approvalsAreLive) return
        scope.launch { runCatching { client.resolveApproval(id, status == ApprovalStatus.Approved) }.getOrNull()?.let(::applyApproval) }
    }

    // MARK: Chat

    suspend fun send(text: String, conversationID: String, confirmHeavy: Boolean = false): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return false
        if (!canSend(conversationID)) {
            chatErrors[conversationID] = if (isPaired) "This chat is not ready to send yet." else "Pair this device in Settings to chat with the PC."
            return false
        }
        sendingConversationIDs += conversationID
        chatErrors.remove(conversationID)
        val pending = "pending:${UUID.randomUUID()}"
        try {
            val source = sessionSources[conversationID]
            if (source != null && adoptedSessions[conversationID] == null) {
                val adopted = client.adoptSession(source.provider, source.id)
                adoptedSessions[conversationID] = adopted.session
                defaults.edit().putString(adoptionKey, GatewayJson.encodeToString(MapSerializer(String.serializer(), ManagedSessionDTO.serializer()), adoptedSessions)).apply()
                if (adopted.mode == "fork") {
                    chatNotices[conversationID] = "Continuing in a fork because the desktop session is open. The original session is unchanged."
                    updateConversation(conversationID) { it.copy(title = adopted.session.title) }
                }
            }
            if (conversation(conversationID) == null) return false
            pendingMessageIDs[conversationID] = pending
            updateConversation(conversationID) { it.copy(messages = it.messages + ChatMessage(pending, MessageSender.User, trimmed, Instant.now()), lastActivityAt = Instant.now()) }
            typingConversationIDs += conversationID
            typingStartedAt[conversationID] = Instant.now()
            val route = liveRoutes[conversationID]
            val adopted = adoptedSessions[conversationID]
            val accepted = when {
                route != null -> client.sendRouteMessage(route.id, trimmed, confirmHeavy = confirmHeavy)
                adopted != null -> client.sendSessionMessage(adopted.id, trimmed, confirmHeavy)
                else -> throw ClientError.InvalidResponse()
            }
            updateConversation(conversationID) { c ->
                if (c.messages.any { it.id == accepted.messageId }) c.copy(messages = c.messages.filter { it.id != pending })
                else c.copy(messages = c.messages.map { if (it.id == pending) it.copy(id = accepted.messageId) else it })
            }
            awaitingUserMessageIDs[conversationID] = accepted.messageId
            return true
        } catch (e: ClientError.HeavySession) {
            updateConversation(conversationID) { c -> c.copy(messages = c.messages.filter { it.id != pending }) }
            clearTyping(conversationID)
            heavySessionPrompt = HeavySessionPrompt(conversationID, trimmed, e.contextTokens)
            return false
        } catch (e: Exception) {
            updateConversation(conversationID) { c -> c.copy(messages = c.messages.filter { it.id != pending }) }
            clearTyping(conversationID)
            chatErrors[conversationID] = "${e.message} Your draft is saved. If the connection dropped, refresh the chat before sending again."
            return false
        } finally {
            sendingConversationIDs -= conversationID
            pendingMessageIDs.remove(conversationID)
        }
    }

    /** "Continue Anyway" on the heavy-session prompt. */
    suspend fun confirmHeavySend(): Boolean {
        val prompt = heavySessionPrompt ?: return false
        heavySessionPrompt = null
        return send(prompt.text, prompt.conversationID, confirmHeavy = true)
    }

    /** "Start Fresh" on the heavy-session prompt (front doors only). */
    suspend fun startFreshAndSend(): Boolean {
        val prompt = heavySessionPrompt ?: return false
        heavySessionPrompt = null
        if (conversation(prompt.conversationID)?.frontDoor == null) return false
        resetFrontDoorConversation(prompt.conversationID)
        return send(prompt.text, prompt.conversationID)
    }

    fun dismissHeavySessionPrompt() { heavySessionPrompt = null }

    // MARK: Calls

    fun startCall(door: FrontDoor) = startCall(door.displayName, door.provider)

    /** Starts the system call at once, and `POST /v1/calls/start` in parallel; whichever finishes last speaks the greeting. */
    fun startCall(title: String, provider: Provider) {
        if (activeCall != null) return
        callError = null
        val call = ActiveCall(title, provider, Instant.now(), CallPhase.Connecting, emptyList())
        callScreenHidden = false
        activeCall = call
        if (!session.isPaired) { startSampleCall(call); return }

        callAudioReady = false
        pendingCallScript = null
        pendingRingbackMs = null
        ringbackActive = false
        hangupAfterReply = false
        activeCallIsIncoming = false
        spokenApproval = null
        GatewayService.running?.goForeground(inCall = true)
        callAudio.startOutgoing(title)
        audioRoute = callAudio.currentRoute
        watchConnecting(call.id)

        scope.launch {
            try {
                val dto = client.startCall(provider)
                if (activeCall?.id != call.id) return@launch // ended before this returned
                activeCallID = dto.id
                if (dto.title.isNotEmpty()) activeCall = activeCall?.copy(title = dto.title)
                dto.routeId?.let { routeId ->
                    activeCallRouteID = routeId
                    runCatching { client.getRoute(routeId) }.getOrNull()?.let { liveRoutes[routeId] = it }
                }
                pendingCallScript = dto.script
                pendingRingbackMs = dto.ringbackMs
                dto.scriptClip?.let { clip -> pendingGreetingClip = scope.async { runCatching { client.clipData(clip.url) }.getOrNull() } }
                beginCallSpeechIfReady()
            } catch (e: Exception) {
                if (activeCall?.id != call.id) return@launch
                callError = e.message
                callAudio.endCall()
            }
        }
        scope.launch { runCatching { client.voiceHints() }.getOrNull()?.let { callAudio.voiceLoop.contextualStrings = it } }
    }

    /** A call must never sit on "Connecting" for good. */
    private fun watchConnecting(callID: String) {
        scope.launch {
            delay(15_000)
            if (activeCall?.id != callID || activeCall?.phase != CallPhase.Connecting) return@launch
            if (callAudioReady && activeCallID != null) markListeningIfIdle()
            else {
                Log.e(TAG, "stuck connecting: audio ready=$callAudioReady, gateway call=${activeCallID != null}")
                callError = "Couldn't connect. Try again."
                callAudio.endCall()
            }
        }
    }

    private fun markListeningIfIdle() {
        if (activeCall?.phase != CallPhase.Connecting || ringbackActive || callAudio.voiceLoop.isBusy) return
        activeCall = activeCall?.copy(phase = CallPhase.Listening)
    }

    /** Fires once from whichever of (audio ready, gateway call started) finishes last. */
    private fun beginCallSpeechIfReady() {
        val script = pendingCallScript
        if (!callAudioReady || script == null || activeCall == null) return
        val ms = pendingRingbackMs
        if (ms != null && !activeCallIsIncoming) {
            pendingRingbackMs = null
            val tone = RingbackTone.pcm(ms)
            if (tone.isNotEmpty()) {
                ringbackActive = true
                ringbackGeneration++
                val generation = ringbackGeneration
                callAudio.voiceLoop.playTone(tone, 24_000) {
                    if (ringbackGeneration != generation) return@playTone
                    ringbackActive = false
                    beginCallSpeechIfReady()
                }
                return
            }
        }
        if (ringbackActive) return
        pendingCallScript = null
        val greetingClip = pendingGreetingClip
        pendingGreetingClip = null
        val callID = activeCall?.id
        scope.launch {
            try {
                if (script.isNotEmpty()) {
                    appendTranscript(TranscriptLine(MessageSender.Agent, script))
                    // The PC-voice recording when there is one, the phone's voice otherwise.
                    val wav = greetingClip?.await()
                    if (activeCall?.id != callID) return@launch
                    if (wav != null) {
                        callAudio.voiceLoop.playClip(wav)
                        return@launch // the spoken status below is only in the phone's voice; skip it so the voice stays Helix's
                    }
                    callAudio.speak(script)
                }
                val routeId = activeCallRouteID
                if (activeCallIsIncoming || routeId == null) return@launch
                // Said right after the greeting, instant and model-free.
                val digest = runCatching { client.digest() }.getOrNull() ?: return@launch
                if (activeCall == null || activeCallRouteID != routeId) return@launch
                appendTranscript(TranscriptLine(MessageSender.Agent, digest.spoken))
                callAudio.speak(digest.spoken)
            } finally {
                markListeningIfIdle()
            }
        }
    }

    fun answerRinging() = callAudio.answerRinging()
    fun declineRinging() = callAudio.declineRinging()

    /** The user answered a call the gateway rang: fetch what it is about, then speak and either talk or run the approval flow. */
    private fun answerIncomingCall(id: String) {
        if (!session.isPaired || id.isEmpty()) { callAudio.endCall(); return }
        callError = null
        callAudioReady = false
        pendingCallScript = null
        spokenApproval = null
        pendingRingbackMs = null
        hangupAfterReply = false
        activeCallIsIncoming = true
        activeCallID = id
        activeCallRouteID = null
        val title = ringingTitle?.takeIf { it.isNotEmpty() } ?: "Claude"
        val call = ActiveCall(title, Provider.Claude, Instant.now(), CallPhase.Connecting, emptyList())
        ringingTitle = null
        ringing = null
        callScreenHidden = false
        activeCall = call
        GatewayService.running?.goForeground(inCall = true)
        audioRoute = callAudio.currentRoute

        scope.launch {
            try {
                val dto = client.answerCall(id)
                if (activeCall?.id != call.id) return@launch
                if (dto.title.isNotEmpty()) activeCall = activeCall?.copy(title = dto.title)
                dto.routeId?.let { routeId ->
                    activeCallRouteID = routeId
                    runCatching { client.getRoute(routeId) }.getOrNull()?.let { liveRoutes[routeId] = it }
                }
                if (dto.expects == "approval") spokenApproval = SpokenApproval()
                pendingCallScript = dto.script
                pendingGreetingClip = scope.async { client.callScriptAudio(id) }
                beginCallSpeechIfReady()
            } catch (e: Exception) {
                if (activeCall?.id != call.id) return@launch
                Log.e(TAG, "gateway answer failed: ${e.message}")
                callError = e.message
                callAudio.endCall()
            }
        }
        scope.launch { runCatching { client.voiceHints() }.getOrNull()?.let { callAudio.voiceLoop.contextualStrings = it } }
    }

    /** One turn of the keyword-matched approval conversation (never a language model). */
    private fun handleApprovalUtterance(text: String) {
        val flow = spokenApproval ?: return
        val callID = activeCallID ?: return
        appendTranscript(TranscriptLine(MessageSender.User, text))
        when (val outcome = flow.hear(text)) {
            null -> Unit
            is SpokenApproval.Outcome.Say -> {
                appendTranscript(TranscriptLine(MessageSender.Agent, outcome.text))
                callAudio.speak(outcome.text)
            }
            is SpokenApproval.Outcome.Send -> scope.launch {
                val reply = runCatching { client.decideCall(callID, outcome.approve) }
                    .fold({ if (outcome.approve) "Approved. Goodbye." else "Rejected. Goodbye." }, { "That request is no longer waiting. Goodbye." })
                if (activeCallID != callID) return@launch
                appendTranscript(TranscriptLine(MessageSender.Agent, reply))
                callAudio.speak(reply)
                hangUpWhenQuiet(callID)
            }
        }
    }

    /** Lets the last spoken line finish before ending the call. */
    private suspend fun hangUpWhenQuiet(callID: String, maxWait: Double = 10.0) {
        delay(700)
        var waited = 0.0
        while (callAudio.voiceLoop.isBusy && waited < maxWait) { delay(300); waited += 0.3 }
        if (activeCallID == callID) callAudio.endCall()
    }

    private fun sendActiveCallUtterance(text: String) {
        if (ringbackActive) return
        if (spokenApproval != null) { handleApprovalUtterance(text); return }
        val routeId = activeCallRouteID ?: return
        if (activeCall == null) return
        appendTranscript(TranscriptLine(MessageSender.User, text))
        scope.launch { runCatching { client.sendRouteMessage(routeId, text, voice = true) } }
    }

    /** Unpaired: the sample flow, so the app can be tried without a gateway. */
    private fun startSampleCall(call: ActiveCall) {
        scope.launch {
            delay(1_500)
            if (activeCall?.id != call.id) return@launch
            activeCall = activeCall?.copy(phase = CallPhase.Speaking, transcript = activeCall!!.transcript + TranscriptLine(MessageSender.Agent, "Hey, what's up?"))
            delay(1_500)
            if (activeCall?.id != call.id) return@launch
            activeCall = activeCall?.copy(phase = CallPhase.Listening)
        }
    }

    private fun appendTranscript(line: TranscriptLine) {
        activeCall = activeCall?.let { it.copy(transcript = it.transcript + line) }
    }

    /** Ends through the call system when there is a real call, so it and the app agree it is over. */
    fun endCall() {
        if (activeCall == null) return
        if (activeCallID != null || callAudio.activeCallId != null) callAudio.endCall() else finishActiveCall()
    }

    private fun finishActiveCall() {
        val call = activeCall ?: return
        calls = listOf(
            Call(
                id = activeCallID ?: call.id, direction = if (activeCallIsIncoming) CallDirection.Incoming else CallDirection.Outgoing,
                status = CallStatus.Ended, severity = Severity.Info, title = "Call ${call.title}",
                summary = call.transcript.lastOrNull()?.text ?: "No conversation", provider = call.provider,
                createdAt = call.startedAt, duration = DurationText.between(call.startedAt, Instant.now()),
            ),
        ) + calls
        activeCallRouteID?.let(liveRoutes::remove)
        val endedCallID = activeCallID
        isMuted = false
        callScreenHidden = false
        pcSentences.clear()
        appleFallbackTurns.clear()
        pendingGreetingClip = null
        activeCall = null
        activeCallID = null
        activeCallRouteID = null
        callAudioReady = false
        pendingCallScript = null
        spokenApproval = null
        activeCallIsIncoming = false
        pendingRingbackMs = null
        ringbackActive = false
        ringbackGeneration++
        hangupAfterReply = false
        GatewayService.running?.goForeground(inCall = false)
        if (endedCallID == null || !session.isPaired) return
        scope.launch { runCatching { client.endCall(endedCallID) } }
    }

    private companion object {
        const val TAG = "HelixStore"

        /** Claude Code's own housekeeping in a resumed transcript is not for a person to read. */
        fun isInternalNoise(text: String) = text.contains("<task-notification>") || text.contains("<system-reminder>")
    }
}

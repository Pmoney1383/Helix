import Foundation
import Observation
import os

enum AppTab: Hashable {
    case home
    case chats
    case calls
    case settings
}

/// App state and the live gateway connection. Views only talk to this type.
@Observable
final class HelixStore {
    var selectedTab: AppTab = .home
    /// A screen on Home that something outside the UI (a tapped notification) wants open.
    /// `HomeView` consumes it, including on a cold start where it only appears afterwards.
    var pendingHomeRoute: HomeRoute?
    var gateway: GatewayStatus
    var pc: PCStatus
    var heroUpdate: HeroUpdate?
    var conversations: [Conversation]
    var sessions: [AgentSession]
    var watchers: [Watcher]
    var approvals: [Approval]
    var calls: [Call]
    var presence: PresenceMode = .auto
    /// The real decision behind `presence` once synced (away/home right now, why, whether the
    /// PC's idle-helper is even running) - not shown anywhere yet, but there for when it is.
    private(set) var presenceStatus: PresenceStatusDTO?
    var persona: PersonaSettings
    var activeCall: ActiveCall?
    var typingConversationIDs: Set<String> = []
    var loadingConversationIDs: Set<String> = []
    var sendingConversationIDs: Set<String> = []
    var chatErrors: [String: String] = [:]
    var chatNotices: [String: String] = [:]
    var sessionsError: String?
    var isLoadingSessions = false
    /// Live PC numbers for the Status screen (`GET /v1/pc/status`); nil until the first fetch lands.
    var pcReport: PCStatusResponse?
    var pcStatusError: String?
    var gatewayUptimeSec: Int?
    /// Device-key request signing: nil until checked. `signingProblem` is set when the gateway
    /// wants signed requests but this phone cannot produce them (key lost): pair again.
    var signingStatus: GatewayClient.SigningStatus?
    var signingProblem: String?
    var hasMoreHistory: Set<String> = []
    var streamingReplies: [String: String] = [:]

    /// Set when a send 409s as `heavy_session` - the session is big enough and cold enough that
    /// continuing it re-reads the whole context at full price. The draft is held here (not lost,
    /// not re-shown in the composer) until the user picks fresh vs. continue anyway.
    struct HeavySessionPrompt: Identifiable {
        let id = UUID()
        let conversationID: String
        let text: String
        let contextTokens: Int
    }
    var heavySessionPrompt: HeavySessionPrompt?

    /// Real networking starts here: where the gateway is and whether this device is paired.
    /// Chat and sessions are live once paired. Some non-chat features still use sample data.
    let gatewaySession: GatewaySession
    private let urlSession: URLSession
    private let defaults: UserDefaults
    private var adoptionKey: String { "chat.adoptions.\(gatewaySession.baseURL.absoluteString).\(gatewaySession.deviceID ?? "unpaired")" }
    var isPairing = false
    var pairingErrorMessage: String?
    private var gatewayClient: GatewayClient { GatewayClient(session: gatewaySession, urlSession: urlSession) }
    private var webSocket: GatewayWebSocket?
    /// Conversation id (== route id) -> the route backing it. A conversation present here is
    /// real; non-live conversations never send or produce sample replies.
    private var liveRoutes: [String: RouteDTO] = [:]
    private var sessionSources: [String: AgentSessionInfoDTO] = [:]
    private var adoptedSessions: [String: ManagedSessionDTO] = [:]
    private var historyCursors: [String: Int] = [:]
    /// "Start Here" (General Claude/Astra) opens blank every visit - see
    /// `resetFrontDoorConversation`. Anything from before the recorded moment is filtered out
    /// wherever history gets merged in, whether from the initial sync, a reconnect refresh, or
    /// the HTTP-recovery poll; anything from this visit onward still shows normally.
    private var historyCutoffs: [String: Date] = [:]
    private var openedConversations: Set<String> = []
    private var pendingMessageIDs: [String: String] = [:]
    private var awaitingUserMessageIDs: [String: String] = [:]
    /// Backstop for `typingConversationIDs` - see `clearStaleTypingState`.
    private var typingStartedAt: [String: Date] = [:]
    /// Gateway session id -> title, from whatever sessions have been synced so far. Approvals
    /// only carry a `sessionId` on the wire (no title), so this is how `mapApproval` names one.
    private var sessionTitlesByID: [String: String] = [:]
    /// Once a real sync of approvals succeeds, `approve`/`reject` send for real too - mirrors
    /// `liveRoutes` for chat, but approvals have no per-item "is this one real" marker on their
    /// own, so one flag for the whole list.
    private var approvalsAreLive = false

    // MARK: Calls (real)

    private let callAudio = CallAudioManager()
    /// The gateway's `Call.id` for the active call - distinct from `activeCall.id` (a local
    /// UUID CallKit was given before the network call even returned).
    private var activeCallID: String?
    /// The active call's own route - fresh every call (`POST /v1/calls/start` always creates
    /// one, unlike the reused front-door routes), tracked in `liveRoutes` the same way a chat
    /// route is so `agent.speech`/`route.handoff` resolve against it with the same code.
    private var activeCallRouteID: String?
    private var callAudioReady = false
    private var pendingCallScript: String?
    var callError: String?
    /// The call on screen was rung by the gateway (PushKit) rather than started by the user.
    private var activeCallIsIncoming = false
    /// Set only on an answered `expects: "approval"` call: the keyword-matching decision flow.
    private var spokenApproval: SpokenApproval?
    /// Title of the ringing incoming call, kept until it is answered or dismissed.
    private var ringingTitle: String?
    private var pushConnected = false
    private nonisolated static let callLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "helix", category: "Call")

    init(
        gateway: GatewayStatus = SampleData.gateway,
        pc: PCStatus = SampleData.pc,
        heroUpdate: HeroUpdate? = SampleData.hero,
        conversations: [Conversation] = SampleData.conversations,
        sessions: [AgentSession] = SampleData.sessions,
        watchers: [Watcher] = SampleData.watchers,
        approvals: [Approval] = SampleData.approvals,
        calls: [Call] = SampleData.calls,
        persona: PersonaSettings = SampleData.persona,
        gatewaySession: GatewaySession = GatewaySession(),
        urlSession: URLSession = .shared,
        defaults: UserDefaults = .standard
    ) {
        self.gateway = gateway
        self.pc = pc
        self.heroUpdate = heroUpdate
        self.conversations = conversations
        self.sessions = sessions
        self.watchers = watchers
        self.approvals = approvals
        self.calls = calls
        self.persona = persona
        self.gatewaySession = gatewaySession
        self.urlSession = urlSession
        self.defaults = defaults
        if gatewaySession.isPaired {
            self.conversations = []
            self.sessions = []
            self.watchers = []
            if let data = defaults.data(forKey: adoptionKey),
               let saved = try? JSONDecoder().decode([String: ManagedSessionDTO].self, from: data) {
                adoptedSessions = saved
            }
        }
        setUpCallAudio()
    }

    /// PC-voice bookkeeping (see `handle(_:)`): sentences whose audio has not arrived yet, by turn,
    /// and turns that fell back to Apple's voice.
    private var pcSentences: [String: [Int: String]] = [:]
    private var appleFallbackTurns: Set<String> = []
    private var pendingGreetingClip: Task<Data?, Never>?

    /// The call screen can be minimised without ending the call.
    var callScreenHidden = false
    private(set) var isMuted = false

    func setMuted(_ muted: Bool) {
        isMuted = muted
        callAudio.voiceLoop.isMuted = muted
        callAudio.setMuted(muted)
    }

    /// Outgoing-call ringback: queued once the gateway answers, played when the audio is up, and
    /// the greeting waits until it ends. Recognition results are ignored while it plays.
    private var pendingRingbackMs: Int?
    private var ringbackActive = false
    private var ringbackGeneration = 0
    /// Set by `call.hangup`: the next reply is the goodbye; end the call once it has been spoken.
    private var hangupAfterReply = false

    /// Wired once, not per call: these closures check `activeCall` themselves rather than being
    /// reassigned every `startCall`.
    private func setUpCallAudio() {
        callAudio.onReadyToSpeak = { [weak self] in
            self?.callAudioReady = true
            self?.beginCallSpeechIfReady()
        }
        callAudio.onMuteChanged = { [weak self] muted in
            self?.isMuted = muted
        }
        callAudio.onCallEnded = { [weak self] in
            self?.finishActiveCall()
        }
        callAudio.voiceLoop.onFinalUtterance = { [weak self] text in
            self?.sendActiveCallUtterance(text)
        }
        callAudio.voiceLoop.onBusyChanged = { [weak self] busy in
            guard let self, self.activeCall != nil else { return }
            self.activeCall?.phase = busy ? .speaking : .listening
        }
        callAudio.onIncomingAnswered = { [weak self] id in
            self?.answerIncomingCall(id)
        }
        callAudio.onIncomingDeclined = { [weak self] id in
            guard let self, self.gatewaySession.isPaired else { return }
            self.ringingTitle = nil
            Task { _ = try? await self.gatewayClient.declineCall(id) }
        }
    }

    // MARK: Push (docs/CALLS.md sections 1-3)

    /// Called once, for the app's real store only (`AppServices.store`) - not for stores built by
    /// tests or previews, which must never register tokens or react to real pushes.
    func connectPush() {
        pushConnected = true
        let push = PushService.shared
        push.onIncomingCall = { [weak self] incoming, completion in
            guard let self else { completion(); return }
            // Report first, ask the gateway anything after (Apple's rule): the push alone is
            // enough to ring, even if it carried no usable call id.
            self.ringingTitle = incoming?.title
            self.callAudio.reportIncoming(
                gatewayCallID: incoming?.callID ?? "", caller: incoming?.caller ?? "Claude", completion: completion
            )
        }
        push.onTokensChanged = { [weak self] in
            self?.registerPushTokens()
        }
        push.onAlertTapped = { [weak self] alert in
            self?.openFromNotification(alert)
        }
        push.onApprovalAction = { [weak self] id, approve in
            await self?.resolveApprovalFromNotification(id, approve: approve)
        }
        registerPushTokens()
    }

    /// Tokens change; the gateway needs them on every launch, after pairing, and whenever iOS
    /// issues a new one. Does nothing until paired and until Apple has issued a token.
    func registerPushTokens() {
        guard pushConnected, gatewaySession.isPaired else { return }
        let push = PushService.shared
        let client = gatewayClient
        let bundleId = Bundle.main.bundleIdentifier ?? ""
        let environment = PushToken.environment
        Task {
            for (kind, token) in [("voip", push.voipToken), ("alert", push.alertToken)] {
                guard let token else { continue }
                do {
                    try await client.registerPushToken(kind: kind, token: token, environment: environment, bundleId: bundleId)
                } catch {
                    print("HelixStore: registering \(kind) push token failed: \(error)")
                }
            }
        }
    }

    private func openFromNotification(_ alert: AlertPush) {
        switch alert.kind {
        case .approval:
            selectedTab = .home
            pendingHomeRoute = .approvals
            Task { await syncApprovals() }
        case .missedCall:
            selectedTab = .calls
        case .event:
            selectedTab = .chats
        }
    }

    /// Approve/Reject buttons on an approval notification. Goes straight to the gateway: the app
    /// may have been launched in the background just for this.
    private func resolveApprovalFromNotification(_ id: String, approve: Bool) async {
        guard gatewaySession.isPaired else { return }
        if approve {
            guard await DeviceAuth.confirm(reason: "Approve this request") else {
                // Cancelled or failed: nothing is sent; show the request so it can be decided in the app.
                selectedTab = .home
                pendingHomeRoute = .approvals
                return
            }
        }
        do {
            let resolved = try await gatewayClient.resolveApproval(id, approve: approve)
            applyApproval(resolved)
        } catch {
            print("HelixStore: approval action from notification failed: \(error)")
        }
    }

    // MARK: Pairing

    var isPaired: Bool { gatewaySession.isPaired }

    /// Called by the pairing sheet. On success the token is already persisted (Keychain) before
    /// this returns, and `gateway` is refreshed from a real health check.
    @MainActor
    func pair(code: String, deviceName: String, gatewayAddress: URL) async {
        pairingErrorMessage = nil
        isPairing = true
        defer { isPairing = false }

        gatewaySession.setBaseURL(gatewayAddress)
        do {
            let result = try await gatewayClient.pair(code: code, deviceName: deviceName)
            gatewaySession.store(deviceID: result.deviceId, token: result.token)
            registerPushTokens()
            await refreshGatewayStatus()
        } catch {
            pairingErrorMessage = error.localizedDescription
        }
    }

    /// Makes sure this phone's Secure Enclave key is enrolled with the gateway (once per device).
    @MainActor
    private func ensureSigning() async {
        do {
            var status = try await gatewayClient.signingStatus()
            if !status.enrolled {
                try await gatewayClient.enrollSigningKey()
                status = try await gatewayClient.signingStatus()
            }
            signingStatus = status
            signingProblem = nil
        } catch GatewayClient.ClientError.http(409, _) {
            signingProblem = "This phone's signing key doesn't match the one the gateway has. Pair again."
        } catch GatewayClient.ClientError.http(401, let message) {
            signingProblem = message == "signature_required" || message == "bad_signature"
                ? "The gateway wants signed requests and this phone has no matching key. Pair again."
                : nil
        } catch {
            // Offline or an older gateway without the endpoint: leave the last known state.
        }
    }

    /// Updates `gateway` from a real `/health` call. Safe to call anytime (unpaired just marks
    /// offline); call it at launch and after pairing so Settings never shows stale sample data.
    @MainActor
    func refreshGatewayStatus() async {
        gateway.address = gatewaySession.baseURL.host ?? gateway.address
        guard gatewaySession.isPaired else {
            gateway.isOnline = false
            return
        }
        do {
            let health = try await gatewayClient.checkHealth()
            gateway.isOnline = health.ok
            gatewayUptimeSec = health.uptimeSec
            gateway.hostName = health.name
            gateway.lastHeartbeat = .now
            await ensureSigning() // before the WebSocket: a gateway that requires signing refuses an unsigned upgrade
            startLiveSyncIfNeeded()
        } catch {
            gateway.isOnline = false
        }
    }

    private var lastVoiceWarm = Date.distantPast

    /// Wakes the PC voice (it takes ~40 s to load after a quiet spell). Called when the app comes
    /// to the foreground and when the Calls tab opens; at most once a minute.
    @MainActor
    func warmVoice() {
        guard gatewaySession.isPaired, Date.now.timeIntervalSince(lastVoiceWarm) > 60 else { return }
        lastVoiceWarm = .now
        Task { await gatewayClient.warmVoice() }
    }

    /// Everything the Status screen shows, refreshed together: gateway health, PC load, sessions
    /// and watchers. Each part fails on its own so one missing endpoint doesn't blank the rest.
    @MainActor
    func refreshStatus() async {
        await refreshGatewayStatus()
        guard gatewaySession.isPaired else { return }
        async let sessionsDone: Void = syncAgentSessions()
        do {
            pcReport = try await gatewayClient.pcStatus()
            pcStatusError = nil
        } catch GatewayClient.ClientError.http(let status, _) where status == 404 {
            pcStatusError = "PC load isn't available from this gateway yet."
        } catch {
            pcStatusError = "Couldn't read the PC: \(error.localizedDescription)"
        }
        if let list = try? await gatewayClient.watches() {
            watchers = list.map(\.asWatcher).sorted { $0.lastEventAt > $1.lastEventAt }
        }
        await sessionsDone
    }

    // MARK: Live sync (sessions, routes, WebSocket - real data once paired)

    /// Connects the socket (idempotent - a second call just reconnects if needed) and kicks off
    /// one sync of sessions and the two front-door conversations. Called after a successful
    /// health check, so this never runs against a gateway we haven't just confirmed is up.
    @MainActor
    func startLiveSyncIfNeeded() {
        guard gatewaySession.isPaired else { return }
        if webSocket == nil {
            let socket = GatewayWebSocket(session: gatewaySession)
            socket.onEvent = { [weak self] event in self?.handle(event) }
            socket.onConnectionChange = { [weak self] connected in
                guard connected, let self else { return }
                Task {
                    for id in self.openedConversations { await self.loadConversation(id) }
                }
            }
            webSocket = socket
        }
        webSocket?.connect()
        if sessionSources.isEmpty { sessions = [] }
        conversations.removeAll { liveRoutes[$0.id] == nil && sessionSources[$0.id] == nil }
        Task { await syncAgentSessions() }
        Task { await ensureFrontDoorRoutes() }
        Task { await syncApprovals() }
        Task { await syncPresence() }
    }

    @MainActor
    func syncPresence() async {
        guard gatewaySession.isPaired else { return }
        do {
            let status = try await gatewayClient.getPresence()
            presence = status.mode
            presenceStatus = status
        } catch {
            // Transient failure: keep whatever presence is already showing.
        }
    }

    /// Settings' picker calls this directly (same pattern as `persona.apply` a few lines below
    /// it in SettingsView) rather than two-way-binding `presence` straight to the gateway: a
    /// plain binding can't distinguish "the user changed this" from "a sync just set this",
    /// which would otherwise fire a needless PUT every time `syncPresence()` runs.
    func setPresence(_ mode: PresenceMode) {
        presence = mode
        guard gatewaySession.isPaired else { return }
        Task {
            do {
                let status = try await gatewayClient.setPresence(mode)
                presence = status.mode
                presenceStatus = status
            } catch {
                // Optimistic value stands; the next syncPresence() corrects it if it was wrong.
            }
        }
    }

    @MainActor
    func syncAgentSessions() async {
        guard gatewaySession.isPaired else { return }
        guard !isLoadingSessions else { return }
        isLoadingSessions = true
        sessionsError = nil
        defer { isLoadingSessions = false }
        do {
            let infos = try await gatewayClient.listAgentSessions(limit: 100)
            sessions = infos.map(mapSession)
            for info in infos {
                sessionTitlesByID[info.id] = info.title
                registerSessionConversation(info)
            }
        } catch {
            sessionsError = error.localizedDescription
        }
    }

    /// Pending first (so a slow sync doesn't momentarily hide what the user most needs to see),
    /// then whatever else fits in `limit` - resolved history included.
    @MainActor
    func syncApprovals() async {
        guard gatewaySession.isPaired else { return }
        do {
            let pending = try await gatewayClient.listApprovals(status: .pending, limit: 100)
            let resolved = try await gatewayClient.listApprovals(limit: 50)
            let byID = Dictionary(pending.map { ($0.id, $0) } + resolved.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            approvals = byID.values.map(mapApproval).sorted { $0.createdAt > $1.createdAt }
            approvalsAreLive = true
        } catch {
            // Transient failure: keep whatever approvals are already showing, live or sample.
        }
    }

    /// One persistent "General Claude" and one "Astra" conversation, reused across launches
    /// rather than spawning a new one every time `POST /v1/routes` is called (it always creates
    /// a fresh route - see pc-gateway/src/router/router.ts: createRoute).
    @MainActor
    func ensureFrontDoorRoutes() async {
        guard gatewaySession.isPaired else { return }
        for door in FrontDoor.allCases {
            do {
                let route = try await findOrCreateRoute(for: door)
                liveRoutes[route.id] = route
                await syncConversation(for: route, door: door)
            } catch {
                sessionsError = error.localizedDescription
            }
        }
    }

    private func findOrCreateRoute(for door: FrontDoor) async throws -> RouteDTO {
        let existing = try await gatewayClient.listRoutes()
        if let found = existing.first(where: { $0.frontDoor == door.provider }) {
            return found
        }
        return try await gatewayClient.createRoute(provider: door.provider)
    }

    @MainActor
    private func syncConversation(for route: RouteDTO, door: FrontDoor) async {
        var messages: [ChatMessage] = []
        do {
            messages = try await gatewayClient.routeMessages(routeId: route.id).compactMap(mapMessage)
            chatErrors[route.id] = nil
        } catch {
            chatErrors[route.id] = error.localizedDescription
        }
        let conversation = Conversation(
            id: route.id,
            title: door.displayName,
            typeLabel: door == .claude ? "General Claude" : "Astra",
            icon: .logo(door.logo),
            provider: door.provider,
            frontDoor: door,
            lastActivityAt: messages.last?.createdAt ?? route.updatedAt,
            messages: messages
        )
        if conversations.contains(where: { $0.id == route.id }) {
            mergeHistory(messages, into: route.id, older: false)
        } else {
            conversations.removeAll { $0.frontDoor == door }
            conversations.append(conversation)
        }
    }

    /// Every "Start Here" visit looks like a brand new conversation talking to the router -
    /// no scrollback, and no silently continuing wherever an earlier handoff left the route (a
    /// route stays on its handoff target until reset; otherwise "Claude" can quietly become
    /// whatever project session it was last handed to, answering as that session instead of the
    /// front door - confirmed live: a message to "Claude" was answered by an unrelated project
    /// session the route had been handed to earlier). The display clears immediately; the
    /// server-side reset (POST .../reset) is best-effort in the background, since the point is
    /// what the user sees and who answers next, not a round trip they need to wait on.
    func resetFrontDoorConversation(_ id: String) {
        guard let index = conversations.firstIndex(where: { $0.id == id }), conversations[index].frontDoor != nil else { return }
        conversations[index].messages = []
        historyCutoffs[id] = .now
        guard gatewaySession.isPaired, liveRoutes[id] != nil else { return }
        Task {
            if let fresh = try? await gatewayClient.resetRoute(id) {
                liveRoutes[id] = fresh
            }
        }
    }

    func sessionConversationID(_ session: AgentSession) -> String { "session:\(session.key)" }

    private func registerSessionConversation(_ info: AgentSessionInfoDTO) {
        let id = "session:\(info.key)"
        sessionSources[id] = info
        if let adopted = adoptedSessions[id], adopted.providerSessionId != info.id {
            chatNotices[id] = "Continuing in a fork. The original desktop session is unchanged."
        }
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            if adoptedSessions[id] == nil { conversations[index].title = info.title }
            return
        }
        conversations.append(Conversation(
            id: id, title: adoptedSessions[id]?.title ?? info.title, typeLabel: info.projectName ?? "PC session",
            icon: .logo(info.provider == .claude ? FrontDoor.claude.logo : FrontDoor.codex.logo), provider: info.provider,
            lastActivityAt: info.lastActivityAt ?? info.createdAt ?? .distantPast, messages: []
        ))
    }

    /// Viewing is read-only. Adoption is deferred until the first send.
    func loadConversation(_ id: String, older: Bool = false) async {
        guard gatewaySession.isPaired, !loadingConversationIDs.contains(id) else { return }
        openedConversations.insert(id)
        loadingConversationIDs.insert(id)
        chatErrors[id] = nil
        defer { loadingConversationIDs.remove(id) }
        do {
            var messages: [ChatMessage]
            if let source = sessionSources[id] {
                let providerID = adoptedSessions[id]?.providerSessionId ?? source.id
                let page: TranscriptPageDTO
                do {
                    page = try await gatewayClient.sessionTranscript(
                        provider: source.provider, id: providerID, before: older ? historyCursors[id] : nil
                    )
                } catch GatewayClient.ClientError.http(404, _) {
                    // Newly-created threads can precede discovery of their transcript file.
                    guard !older, let managedID = adoptedSessions[id]?.id ?? source.helixSessionId else {
                        throw GatewayClient.ClientError.http(status: 404, message: "History is not available yet. Try refreshing.")
                    }
                    let wire = try await gatewayClient.sessionMessages(sessionID: managedID)
                    let baseline = conversation(id: id)?.messages.filter { $0.id.hasPrefix("transcript:") } ?? []
                    mergeHistory(baseline + wire.compactMap(mapMessage), into: id, older: false)
                    settleReply(from: wire, in: id)
                    return
                }
                if page.hasMore { hasMoreHistory.insert(id) } else { hasMoreHistory.remove(id) }
                historyCursors[id] = page.messages.first?.index
                messages = page.messages.compactMap { message in
                    guard message.role != "tool", !Self.isInternalNoise(message.text) else { return nil }
                    return ChatMessage(
                        id: "transcript:\(providerID):\(message.index)",
                        sender: message.role == "user" ? .user : .agent,
                        text: message.text, createdAt: message.ts ?? source.createdAt ?? .distantPast
                    )
                }
                if !older, let managedID = adoptedSessions[id]?.id ?? source.helixSessionId {
                    let wire = try await gatewayClient.sessionMessages(sessionID: managedID)
                    // Provider transcripts and the gateway ledger describe the same turn using
                    // different IDs. Prefer ledger IDs for current turns so socket replay dedupes.
                    for message in wire {
                        guard let mapped = mapMessage(message) else { continue }
                        if let duplicate = messages.lastIndex(where: {
                            $0.sender == message.sender && $0.text == message.text
                                && abs($0.createdAt.timeIntervalSince(message.createdAt)) < 10
                        }) { messages[duplicate] = mapped }
                        else if message.createdAt >= (messages.first?.createdAt ?? .distantPast) {
                            messages.append(mapped)
                        }
                    }
                    messages.sort { $0.createdAt < $1.createdAt }
                    settleReply(from: wire, in: id)
                }
            } else if let route = liveRoutes[id] {
                let wire = try await gatewayClient.routeMessages(routeId: route.id)
                messages = wire.compactMap(mapMessage)
                settleReply(from: wire, in: id)
            } else { return }
            mergeHistory(messages, into: id, older: older)
        } catch {
            chatErrors[id] = error.localizedDescription
        }
    }

    private func settleReply(from messages: [AgentMessageDTO], in id: String) {
        guard let userID = awaitingUserMessageIDs[id],
              let index = messages.firstIndex(where: { $0.id == userID }),
              messages.dropFirst(index + 1).contains(where: { $0.sender == .agent || $0.sender == .system }) else { return }
        typingConversationIDs.remove(id)
        streamingReplies[id] = nil
        awaitingUserMessageIDs[id] = nil
        typingStartedAt[id] = nil
    }

    private func mergeHistory(_ rawMessages: [ChatMessage], into id: String, older: Bool) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let messages = historyCutoffs[id].map { cutoff in rawMessages.filter { $0.createdAt >= cutoff } } ?? rawMessages
        if older {
            let existing = Set(conversations[index].messages.map(\.id))
            conversations[index].messages.insert(contentsOf: messages.filter { !existing.contains($0.id) }, at: 0)
        } else {
            // Preserve events received while the HTTP snapshot was in flight.
            let newest = messages.last?.createdAt ?? .distantPast
            let ids = Set(messages.map(\.id))
            let newer = conversations[index].messages.filter {
                !ids.contains($0.id) && $0.createdAt > newest && !$0.id.hasPrefix("transcript:")
            }
            conversations[index].messages = messages + newer
        }
        conversations[index].lastActivityAt = conversations[index].messages.last?.createdAt ?? conversations[index].lastActivityAt
    }

    func canSend(to id: String) -> Bool {
        clearStaleTypingState(for: id)
        return gatewaySession.isPaired && (liveRoutes[id] != nil || sessionSources[id] != nil)
            && !sendingConversationIDs.contains(id) && !typingConversationIDs.contains(id)
            && !loadingConversationIDs.contains(id)
    }

    /// `typing` is meant to always clear itself - `settleReply`, `agent.output.final`, or a live
    /// `message.created` all do it. This is the backstop for when none of those fire for
    /// whatever reason (a reply shape `settleReply` doesn't recognize, a dropped socket event):
    /// without it, a chat could refuse every future send forever, which looks exactly like "the
    /// draft never clears" (it clears optimistically, then gets restored because `canSend` keeps
    /// failing). 90s is generous for a normal reply - past it, assume this one was lost.
    private func clearStaleTypingState(for id: String) {
        guard let startedAt = typingStartedAt[id], Date.now.timeIntervalSince(startedAt) > 90 else { return }
        typingConversationIDs.remove(id)
        streamingReplies[id] = nil
        awaitingUserMessageIDs[id] = nil
        typingStartedAt[id] = nil
    }

    // MARK: WebSocket events

    @MainActor
    func handle(_ event: GatewayEvent) {
        switch event {
        case let .messageCreated(message):
            appendLiveMessage(message)
        case let .agentOutputDelta(sessionId, _, text):
            for id in conversationIDs(forSessionId: sessionId) {
                typingConversationIDs.insert(id)
                typingStartedAt[id] = .now
                streamingReplies[id, default: ""] += text
            }
        case let .agentOutputFinal(sessionId, _, _, _, _):
            for id in conversationIDs(forSessionId: sessionId) {
                typingConversationIDs.remove(id)
                typingStartedAt[id] = nil
                streamingReplies[id] = nil
                Task { await self.loadConversation(id) }
            }
        case let .routeHandoff(routeId, _, toSessionId, toTitle, _):
            guard var route = liveRoutes[routeId] else { break }
            route.targetSessionId = toSessionId
            route.currentSessionId = toSessionId
            if !route.visited.contains(toSessionId) { route.visited.append(toSessionId) }
            liveRoutes[routeId] = route
            // Show who's actually answering now, not the front door's fixed name - otherwise
            // a handoff mid-conversation looks exactly like still talking to "Claude"/"Astra".
            if let index = conversations.firstIndex(where: { $0.id == routeId }) {
                conversations[index].title = toTitle
            }
            // The handoff itself resolves whatever turn was pending - a silent connect-only
            // handoff (see routing-only.ts) can complete with no further message.created at all,
            // which otherwise left "typing" stuck true forever: the Chats list kept showing
            // "Typing…" as the preview, self-correcting only once loadConversation ran again
            // (opening the chat). No reason to wait past the handoff for something that may
            // never arrive.
            typingConversationIDs.remove(routeId)
            typingStartedAt[routeId] = nil
            streamingReplies[routeId] = nil
            awaitingUserMessageIDs[routeId] = nil
            // A call can be handed to a specific session mid-call without ending it (docs/CALLS.md
            // section 3b) - same courtesy as the chat title update just above.
            if routeId == activeCallRouteID { activeCall?.title = toTitle }
        case let .agentSpeech(sessionId, turnId, seq, text, engine):
            guard isCallSession(sessionId) else { break }
            activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: text))
            if engine == "pc", !appleFallbackTurns.contains(turnId) {
                // The PC voice speaks this one: its audio follows as agent.audio. Stay quiet.
                pcSentences[turnId, default: [:]][seq] = text
                callAudio.voiceLoop.setPCTurnActive(true)
            } else {
                callAudio.speak(text)
            }
        case let .agentAudio(sessionId, turnId, seq, sampleRate, pcm):
            guard isCallSession(sessionId), !appleFallbackTurns.contains(turnId) else { break }
            pcSentences[turnId]?[seq] = nil
            callAudio.voiceLoop.playPCM(pcm, sampleRate: sampleRate)
        case let .agentAudioEnd(sessionId, turnId):
            guard isCallSession(sessionId) else { break }
            pcSentences[turnId] = nil
            callAudio.voiceLoop.setPCTurnActive(false)
        case let .agentAudioUnavailable(sessionId, turnId):
            guard isCallSession(sessionId) else { break }
            // Say whatever has no audio yet with Apple's voice, and everything else this turn.
            appleFallbackTurns.insert(turnId)
            for (_, text) in (pcSentences[turnId] ?? [:]).sorted(by: { $0.key < $1.key }) { callAudio.speak(text) }
            pcSentences[turnId] = nil
            callAudio.voiceLoop.setPCTurnActive(false)
        case let .agentSpeechEnd(sessionId, _, cancelled):
            if !cancelled, hangupAfterReply, let callID = activeCallID, activeCall != nil,
               let routeId = activeCallRouteID, liveRoutes[routeId]?.visited.contains(sessionId) == true {
                hangupAfterReply = false
                Task { await hangUpWhenQuiet(callID, maxWait: 30) }
                break
            }
            guard cancelled, activeCall != nil, let routeId = activeCallRouteID,
                  liveRoutes[routeId]?.visited.contains(sessionId) == true else { break }
            callAudio.voiceLoop.stopSpeakingAndClearQueue()
            pcSentences.removeAll()
        case let .agentSessionChanged(info):
            upsertSession(info)
        case .callRinging, .callAnswered:
            break // outgoing calls are already answered by the time this app sees them
        case let .callEnded(dto):
            // The gateway ended it from elsewhere (rate limit, ended on another device, ...);
            // tear CallKit down the same way the user tapping End would.
            // Still ringing: it no longer matters (answered elsewhere, missed, approval resolved).
            callAudio.dismissRinging(gatewayCallID: dto.id, reason: dto.status == .missed ? .unanswered : .remoteEnded)
            guard dto.id == activeCallID else { break }
            callAudio.endCall()
        case let .callHangup(dto):
            // Keep the line open: the goodbye reply is spoken first, then we end the call. The
            // gateway hangs up itself if no reply ever comes.
            guard dto.id == activeCallID else { break }
            hangupAfterReply = true
        case .approvalRequested(let dto), .approvalResolved(let dto):
            applyApproval(dto)
        case .hello, .agentTool, .routeCreated, .sendAccepted, .error, .pong, .unknown:
            break
        }
    }

    private func isCallSession(_ sessionId: String) -> Bool {
        guard activeCall != nil, let routeId = activeCallRouteID else { return false }
        return liveRoutes[routeId]?.visited.contains(sessionId) == true
    }

    /// Which live conversation a gateway session id belongs to. A route's history can span
    /// several sessions (router, then whoever it was handed to), so this checks `visited`
    /// membership, not equality with the route's own id - see `RouteDTO`.
    private func conversationIDs(forSessionId sessionId: String) -> [String] {
        liveRoutes.filter { $0.value.visited.contains(sessionId) }.map(\.key)
            + sessionSources.filter { (adoptedSessions[$0.key]?.id ?? $0.value.helixSessionId) == sessionId }.map(\.key)
    }

    private func appendLiveMessage(_ wire: AgentMessageDTO) {
        for conversationID in conversationIDs(forSessionId: wire.conversationId) {
            if let cutoff = historyCutoffs[conversationID], wire.createdAt < cutoff { continue }
            guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { continue }
            if wire.sender == .user, let pending = pendingMessageIDs[conversationID],
               conversations[index].messages.contains(where: { $0.id == pending && $0.text == wire.text }) {
                conversations[index].messages.removeAll { $0.id == pending }
            }
            if !conversations[index].messages.contains(where: { $0.id == wire.id }), let mapped = mapMessage(wire) {
                conversations[index].messages.append(mapped)
            }
            conversations[index].lastActivityAt = wire.createdAt
            if wire.sender == .agent || wire.sender == .system {
                typingConversationIDs.remove(conversationID)
                typingStartedAt[conversationID] = nil
                streamingReplies[conversationID] = nil
            }
        }
    }

    private func upsertSession(_ info: AgentSessionInfoDTO) {
        registerSessionConversation(info)
        sessionTitlesByID[info.id] = info.title
        let mapped = mapSession(info)
        if let index = sessions.firstIndex(where: { $0.key == info.key }) {
            sessions[index] = mapped
        } else {
            sessions.insert(mapped, at: 0)
        }
    }

    private func applyApproval(_ dto: ApprovalDTO) {
        let mapped = mapApproval(dto)
        if let index = approvals.firstIndex(where: { $0.id == dto.id }) {
            approvals[index] = mapped
        } else {
            approvals.insert(mapped, at: 0)
        }
    }

    // MARK: Wire -> UI mapping

    private func mapSession(_ info: AgentSessionInfoDTO) -> AgentSession {
        AgentSession(
            key: info.key,
            provider: info.provider,
            title: info.title,
            projectName: info.projectName,
            lastActivityAt: info.lastActivityAt ?? info.createdAt ?? .distantPast,
            live: info.live,
            liveStatus: info.liveStatus,
            managed: info.managed
        )
    }

    private func mapMessage(_ wire: AgentMessageDTO) -> ChatMessage? {
        guard !Self.isInternalNoise(wire.text) else { return nil }
        return ChatMessage(id: wire.id, sender: wire.sender, text: wire.text, createdAt: wire.createdAt)
    }

    /// Claude Code's own harness injects housekeeping into a resumed session's transcript -
    /// orphaned-background-task summaries, `<system-reminder>` blocks, and the like. None of it
    /// is meant for a person to read; it showed up verbatim as an ordinary chat bubble (seen
    /// live after adopting a session that had just been resumed). Filtered wherever a wire
    /// message becomes a displayed one, not just one call site, since it can appear in a route's
    /// ledger, a session's ledger, or the raw provider transcript alike.
    private static func isInternalNoise(_ text: String) -> Bool {
        text.contains("<task-notification>") || text.contains("<system-reminder>")
    }

    private func mapApproval(_ dto: ApprovalDTO) -> Approval {
        Approval(
            id: dto.id,
            sessionTitle: dto.sessionId.flatMap { sessionTitlesByID[$0] },
            tool: dto.tool,
            summary: dto.summary,
            reasons: dto.reasons,
            status: dto.status,
            createdAt: dto.createdAt,
            expiresAt: dto.expiresAt,
            resolvedAt: dto.resolvedAt
        )
    }

    // MARK: Derived

    var pendingApprovals: [Approval] {
        approvals.filter { $0.status == .pending }.sorted { $0.expiresAt < $1.expiresAt }
    }

    var resolvedApprovals: [Approval] {
        approvals.filter { $0.status != .pending }.sorted { ($0.resolvedAt ?? $0.createdAt) > ($1.resolvedAt ?? $1.createdAt) }
    }

    var recentConversations: [Conversation] {
        conversations.sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    var frontDoorConversations: [Conversation] {
        FrontDoor.allCases.compactMap { door in conversations.first { $0.frontDoor == door } }
    }

    /// What the Chats list actually shows: every real session chat, plus a front door
    /// (General Claude/Astra) only once it has something in it. "+" > New Claude/Astra is the
    /// entry point now (no more always-visible "Start Here" rows); a front door that's never
    /// been used this visit, or was just reset by resetFrontDoorConversation, has nothing to
    /// show and would only be clutter - but one that's mid-conversation still needs to be
    /// reachable without going through "+" again (which would reset it).
    var visibleConversations: [Conversation] {
        recentConversations.filter {
            $0.frontDoor == nil || !$0.messages.isEmpty || typingConversationIDs.contains($0.id)
        }
    }

    func conversation(id: String) -> Conversation? {
        conversations.first { $0.id == id }
    }

    // MARK: Approvals

    /// Approving needs Face ID / passcode, same as from a notification. Rejecting never does.
    func approveWithAuth(_ id: String) {
        Task {
            guard await DeviceAuth.confirm(reason: "Approve this request") else { return }
            approve(id)
        }
    }

    func approve(_ id: String) { resolve(id, as: .approved) }
    func reject(_ id: String) { resolve(id, as: .rejected) }

    private func resolve(_ id: String, as status: ApprovalStatus) {
        guard let index = approvals.firstIndex(where: { $0.id == id && $0.status == .pending }) else { return }
        // Update immediately so the tap feels instant (matches the sample-data behaviour this
        // already had); the real call below corrects this afterward if it turns out to be wrong
        // (for example someone else already resolved it from the PC - the server settles once).
        approvals[index].status = status
        approvals[index].resolvedAt = .now

        guard approvalsAreLive else { return }
        Task {
            do {
                let resolved = try await gatewayClient.resolveApproval(id, approve: status == .approved)
                applyApproval(resolved)
            } catch {
                // Optimistic update stands; the next syncApprovals() corrects it if needed.
            }
        }
    }

    // MARK: Chat

    func send(_ text: String, to conversationID: String, confirmHeavy: Bool = false) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard canSend(to: conversationID) else {
            chatErrors[conversationID] = isPaired ? "This chat is not ready to send yet." : "Pair this device in Settings to chat with the PC."
            return false
        }
        sendingConversationIDs.insert(conversationID)
        chatErrors[conversationID] = nil
        defer { sendingConversationIDs.remove(conversationID); pendingMessageIDs[conversationID] = nil }
        let pending = "pending:\(UUID().uuidString)"
        do {
            if let source = sessionSources[conversationID], adoptedSessions[conversationID] == nil {
                let adopted = try await gatewayClient.adoptSession(provider: source.provider, id: source.id)
                adoptedSessions[conversationID] = adopted.session
                if let saved = try? JSONEncoder().encode(adoptedSessions) { defaults.set(saved, forKey: adoptionKey) }
                if adopted.mode == "fork" {
                    chatNotices[conversationID] = "Continuing in a fork because the desktop session is open. The original session is unchanged."
                    if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
                        conversations[index].title = adopted.session.title
                    }
                }
            }
            guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return false }
            pendingMessageIDs[conversationID] = pending
            conversations[index].messages.append(ChatMessage(id: pending, sender: .user, text: trimmed, createdAt: .now))
            conversations[index].lastActivityAt = .now
            typingConversationIDs.insert(conversationID)
            typingStartedAt[conversationID] = .now
            let accepted: GatewayClient.SendAccepted
            if let route = liveRoutes[conversationID] {
                accepted = try await gatewayClient.sendRouteMessage(routeId: route.id, text: trimmed, confirmHeavy: confirmHeavy)
            } else if let adopted = adoptedSessions[conversationID] {
                accepted = try await gatewayClient.sendSessionMessage(sessionID: adopted.id, text: trimmed, confirmHeavy: confirmHeavy)
            } else { throw GatewayClient.ClientError.invalidResponse }
            if let index = conversations.firstIndex(where: { $0.id == conversationID }),
               let messageIndex = conversations[index].messages.firstIndex(where: { $0.id == pending }) {
                if conversations[index].messages.contains(where: { $0.id == accepted.messageId }) {
                    conversations[index].messages.remove(at: messageIndex)
                } else { conversations[index].messages[messageIndex].id = accepted.messageId }
            }
            awaitingUserMessageIDs[conversationID] = accepted.messageId
            // The visible chat polls its ledger while awaiting a reply, independently of the socket.
            return true
        } catch let GatewayClient.ClientError.heavySession(contextTokens, _) {
            if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[index].messages.removeAll { $0.id == pending }
            }
            typingConversationIDs.remove(conversationID)
            typingStartedAt[conversationID] = nil
            streamingReplies[conversationID] = nil
            heavySessionPrompt = HeavySessionPrompt(conversationID: conversationID, text: trimmed, contextTokens: contextTokens)
            return false
        } catch {
            if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[index].messages.removeAll { $0.id == pending }
            }
            typingConversationIDs.remove(conversationID)
            typingStartedAt[conversationID] = nil
            streamingReplies[conversationID] = nil
            chatErrors[conversationID] = "\(error.localizedDescription) Your draft is saved. If the connection dropped, refresh the chat before sending again."
            return false
        }
    }

    /// "Continue anyway" on the heavy-session prompt: resend the same text with `confirmHeavy`
    /// so the gateway doesn't 409 it a second time.
    @discardableResult
    func confirmHeavySend() async -> Bool {
        guard let prompt = heavySessionPrompt else { return false }
        heavySessionPrompt = nil
        return await send(prompt.text, to: prompt.conversationID, confirmHeavy: true)
    }

    /// "Start a fresh session" on the heavy-session prompt. Only a front-door route has a real
    /// notion of "fresh" distinct from "this, continued" - resetting drops it back to a brand-new
    /// session before the held text is sent. For a specific adopted session there's no other
    /// session to fall back to, so this just discards the prompt and restores the draft.
    @discardableResult
    func startFreshAndSend() async -> Bool {
        guard let prompt = heavySessionPrompt else { return false }
        heavySessionPrompt = nil
        guard conversations.first(where: { $0.id == prompt.conversationID })?.frontDoor != nil else { return false }
        resetFrontDoorConversation(prompt.conversationID)
        return await send(prompt.text, to: prompt.conversationID)
    }

    func dismissHeavySessionPrompt() {
        heavySessionPrompt = nil
    }

    // MARK: Calls

    func startCall(_ door: FrontDoor) {
        startCall(title: door.displayName, provider: door.provider)
    }

    func startCall(to conversation: Conversation) {
        startCall(title: conversation.frontDoor?.displayName ?? conversation.title, provider: conversation.provider)
    }

    /// Real, not simulated: reports to CallKit immediately (for the native call UI - no reason
    /// to wait on the network for that), then `POST /v1/calls/start` in parallel. Whichever
    /// finishes last - the audio session activating, or the gateway call - triggers speaking the
    /// greeting via `beginCallSpeechIfReady`. Falls back to the sample flow if unpaired, so
    /// previews/tests (which never pair) keep working exactly as before.
    func startCall(title: String, provider: Provider) {
        guard activeCall == nil else { return }
        callError = nil
        let call = ActiveCall(title: title, provider: provider, startedAt: .now, phase: .connecting, transcript: [])
        callScreenHidden = false
        activeCall = call

        guard gatewaySession.isPaired else {
            startSampleCall(call)
            return
        }

        callAudioReady = false
        pendingCallScript = nil
        pendingRingbackMs = nil
        ringbackActive = false
        hangupAfterReply = false
        activeCallIsIncoming = false
        spokenApproval = nil
        callAudio.startOutgoing(handle: title)
        watchConnecting(call.id)

        Task {
            do {
                let dto = try await gatewayClient.startCall(provider: provider)
                guard activeCall?.id == call.id else { return } // ended before this returned
                activeCallID = dto.id
                if !dto.title.isEmpty { activeCall?.title = dto.title }
                if let routeId = dto.routeId {
                    activeCallRouteID = routeId
                    if let route = try? await gatewayClient.getRoute(routeId) {
                        liveRoutes[routeId] = route
                    }
                }
                pendingCallScript = dto.script
                pendingRingbackMs = dto.ringbackMs
                if let clip = dto.scriptClip {
                    pendingGreetingClip = Task { [gatewayClient] in try? await gatewayClient.clipData(path: clip.url) }
                }
                beginCallSpeechIfReady()
            } catch {
                guard activeCall?.id == call.id else { return }
                callError = error.localizedDescription
                callAudio.endCall() // tears down CallKit -> onCallEnded -> finishActiveCall
            }
        }

        Task {
            // Best-effort, non-blocking: contextualStrings only need to be set before the user
            // actually starts talking, not before the greeting plays.
            if let hints = try? await gatewayClient.voiceHints() {
                callAudio.voiceLoop.contextualStrings = hints
            }
        }
    }

    /// A call must never sit on "Connecting" for good. If CallKit never activated the audio or the
    /// gateway never answered, give up with an error; if everything is ready but nothing spoke
    /// (so nothing flipped the phase), just start listening.
    private func watchConnecting(_ callID: UUID) {
        Task {
            try? await Task.sleep(for: .seconds(15))
            guard activeCall?.id == callID, activeCall?.phase == .connecting else { return }
            if callAudioReady, activeCallID != nil {
                markListeningIfIdle()
            } else {
                Self.callLog.error("stuck connecting: audio ready=\(self.callAudioReady), gateway call=\(self.activeCallID != nil)")
                callError = "Couldn't connect. Try again."
                callAudio.endCall()
            }
        }
    }

    /// Nothing is playing and nothing is about to: the call is simply waiting for the user.
    private func markListeningIfIdle() {
        guard activeCall?.phase == .connecting, !ringbackActive, !callAudio.voiceLoop.isBusy else { return }
        activeCall?.phase = .listening
    }

    /// Fires once from whichever of (audio ready, gateway call started) finishes last.
    private func beginCallSpeechIfReady() {
        Self.callLog.notice("beginCallSpeechIfReady: audio ready=\(self.callAudioReady), script pending=\(self.pendingCallScript != nil)")
        guard callAudioReady, let script = pendingCallScript, activeCall != nil else { return }
        if let ms = pendingRingbackMs, !activeCallIsIncoming {
            pendingRingbackMs = nil
            if let tone = RingbackTone.buffer(durationMs: ms) {
                ringbackActive = true
                ringbackGeneration += 1
                let generation = ringbackGeneration
                callAudio.voiceLoop.playTone(tone) { [weak self] in
                    Task { @MainActor in
                        guard let self, self.ringbackGeneration == generation else { return }
                        self.ringbackActive = false
                        self.beginCallSpeechIfReady()
                    }
                }
                return
            }
        }
        guard !ringbackActive else { return }
        pendingCallScript = nil
        let greetingClip = pendingGreetingClip
        pendingGreetingClip = nil
        let callID = activeCall?.id
        Task {
            if !script.isEmpty {
                activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: script))
                // The PC-voice recording when there is one, Apple's voice otherwise.
                let wav = await greetingClip?.value
                guard activeCall?.id == callID else { return }
                if let wav {
                    callAudio.voiceLoop.playClip(wav)
                    return // the spoken status below is only Apple-voiced; skip it so the voice stays Helix's
                }
                callAudio.speak(script)
            }
            defer { markListeningIfIdle() }
            guard !activeCallIsIncoming, let routeId = activeCallRouteID else { return }
            // Said right after the greeting, instant and model-free - "what's going on" without
            // making the user wait on a real reply for it.
            guard let digest = try? await gatewayClient.digest(), activeCall != nil, activeCallRouteID == routeId else { return }
            activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: digest.spoken))
            callAudio.speak(digest.spoken)
        }
    }

    /// The user tapped Answer on a call the gateway rang. CallKit is already up; fetch what the
    /// call is about, then speak its script and either run the spoken-approval flow or talk
    /// through the route. A 409 means it stopped mattering while it rang: just hang up.
    private func answerIncomingCall(_ id: String) {
        Self.callLog.notice("incoming call answered in CallKit (gateway id \(id, privacy: .public))")
        guard gatewaySession.isPaired, !id.isEmpty else { callAudio.endCall(); return }
        callError = nil
        callAudioReady = false
        pendingCallScript = nil
        spokenApproval = nil
        pendingRingbackMs = nil
        hangupAfterReply = false
        activeCallIsIncoming = true
        activeCallID = id
        activeCallRouteID = nil
        let title = ringingTitle.flatMap { $0.isEmpty ? nil : $0 } ?? "Claude"
        let call = ActiveCall(title: title, provider: .claude, startedAt: .now, phase: .connecting, transcript: [])
        ringingTitle = nil
        callScreenHidden = false
        activeCall = call

        Task {
            do {
                let dto = try await gatewayClient.answerCall(id)
                guard activeCall?.id == call.id else { return }
                if !dto.title.isEmpty { activeCall?.title = dto.title }
                if let routeId = dto.routeId {
                    activeCallRouteID = routeId
                    if let route = try? await gatewayClient.getRoute(routeId) { liveRoutes[routeId] = route }
                }
                if dto.expects == "approval" { spokenApproval = SpokenApproval() }
                Self.callLog.notice("gateway answer ok: expects=\(dto.expects, privacy: .public) script=\(dto.script.count) chars, audio ready=\(self.callAudioReady)")
                pendingCallScript = dto.script
                pendingGreetingClip = Task { [gatewayClient] in await gatewayClient.callScriptAudio(id) }
                beginCallSpeechIfReady()
            } catch {
                guard activeCall?.id == call.id else { return }
                Self.callLog.error("gateway answer failed: \(error.localizedDescription, privacy: .public)")
                callError = error.localizedDescription
                callAudio.endCall()
            }
        }
        Task {
            if let hints = try? await gatewayClient.voiceHints() { callAudio.voiceLoop.contextualStrings = hints }
        }
    }

    /// One turn of the keyword-matched approval conversation (never an LLM; see `SpokenApproval`).
    private func handleApprovalUtterance(_ text: String) {
        guard var flow = spokenApproval, let callID = activeCallID else { return }
        activeCall?.transcript.append(TranscriptLine(speaker: .user, text: text))
        let outcome = flow.hear(text)
        spokenApproval = flow
        Self.callLog.notice("approval utterance heard, phase now \(String(describing: flow.phase), privacy: .public)")
        switch outcome {
        case nil:
            break
        case .say(let reply)?:
            activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: reply))
            callAudio.speak(reply)
        case .send(let approve)?:
            Task {
                let reply: String
                do {
                    _ = try await gatewayClient.decideCall(callID, approve: approve)
                    reply = approve ? "Approved. Goodbye." : "Rejected. Goodbye."
                } catch {
                    reply = "That request is no longer waiting. Goodbye."
                }
                guard activeCallID == callID else { return }
                activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: reply))
                callAudio.speak(reply)
                await hangUpWhenQuiet(callID)
            }
        }
    }

    /// Lets the last spoken line finish before ending the call.
    private func hangUpWhenQuiet(_ callID: String, maxWait: Double = 10) async {
        try? await Task.sleep(for: .seconds(0.7))
        var waited = 0.0
        while callAudio.voiceLoop.isBusy, waited < maxWait {
            try? await Task.sleep(for: .seconds(0.3))
            waited += 0.3
        }
        guard activeCallID == callID else { return }
        callAudio.endCall()
    }

    private func sendActiveCallUtterance(_ text: String) {
        if ringbackActive { return }
        if spokenApproval != nil { handleApprovalUtterance(text); return }
        guard activeCall != nil, let routeId = activeCallRouteID else { return }
        activeCall?.transcript.append(TranscriptLine(speaker: .user, text: text))
        Task {
            try? await gatewayClient.sendRouteMessage(routeId: routeId, text: text, voice: true)
            // The reply streams back as agent.speech/route.handoff events, handled in `handle(_:)`.
        }
    }

    /// Unpaired fallback: the sample flow this always had, so previews and
    /// `endingACallLogsIt`/etc. keep working without a gateway.
    private func startSampleCall(_ call: ActiveCall) {
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard activeCall?.id == call.id else { return }
            activeCall?.phase = .speaking
            activeCall?.transcript.append(TranscriptLine(speaker: .agent, text: "Hey, what's up?"))
            try? await Task.sleep(for: .seconds(1.5))
            guard activeCall?.id == call.id else { return }
            activeCall?.phase = .listening
        }
    }

    /// Always routes through CallKit's end action when there's a real call in progress, so the
    /// native call UI and the app agree it's over; `finishActiveCall` does the actual cleanup
    /// once CallKit confirms (`onCallEnded`). The sample call (never reported to CallKit at all)
    /// finishes directly.
    func endCall() {
        guard activeCall != nil else { return }
        if activeCallID != nil || callAudio.activeCallID != nil {
            callAudio.endCall()
        } else {
            finishActiveCall()
        }
    }

    private func finishActiveCall() {
        guard let call = activeCall else { return }
        calls.insert(
            Call(
                id: activeCallID ?? call.id.uuidString,
                direction: activeCallIsIncoming ? .incoming : .outgoing,
                status: .ended,
                severity: .info,
                title: "Call \(call.title)",
                summary: call.transcript.last?.text ?? "No conversation",
                provider: call.provider,
                createdAt: call.startedAt,
                duration: Date.now.timeIntervalSince(call.startedAt)
            ),
            at: 0
        )
        if let routeId = activeCallRouteID { liveRoutes.removeValue(forKey: routeId) }
        let endedCallID = activeCallID
        isMuted = false
        callAudio.voiceLoop.isMuted = false
        callScreenHidden = false
        pcSentences.removeAll()
        appleFallbackTurns.removeAll()
        pendingGreetingClip = nil
        activeCall = nil
        activeCallID = nil
        activeCallRouteID = nil
        callAudioReady = false
        pendingCallScript = nil
        spokenApproval = nil
        activeCallIsIncoming = false
        pendingRingbackMs = nil
        ringbackActive = false
        ringbackGeneration += 1
        hangupAfterReply = false

        guard let endedCallID, gatewaySession.isPaired else { return }
        Task { try? await gatewayClient.endCall(endedCallID) }
    }
}

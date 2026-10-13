import Foundation

/// Talks to the PC gateway over HTTPS. Stateless beyond the `GatewaySession` it holds - every
/// call reads the current base URL/token at call time, so pairing or an address change takes
/// effect on the very next request with nothing else to wire up.
///
/// Includes pairing, discovery, transcripts, session adoption, messaging, and front-door routes.
struct GatewayClient {
    let session: GatewaySession
    var urlSession: URLSession = .shared

    enum ClientError: LocalizedError {
        case invalidURL
        case invalidResponse
        case http(status: Int, message: String?)
        case decoding(Error)
        case transport(Error)
        case notPaired
        /// 409 `{ code: "heavy_session" }` - the session is above `HELIX_HEAVY_SESSION_TOKENS`
        /// and its prompt cache has expired, so continuing/forking it re-reads the whole context
        /// at full price. The caller decides: reset and send fresh, or resend with `confirmHeavy`.
        case heavySession(contextTokens: Int, reason: String)

        var errorDescription: String? {
            switch self {
            case .invalidURL, .invalidResponse:
                return "The gateway sent back something unexpected."
            case .notPaired:
                return "This device isn't paired yet."
            case .http(401, _):
                return "The pairing was rejected or has expired. Pair again."
            case .http(429, _):
                return "Too many attempts. Wait a few minutes and try again."
            case let .http(status, message):
                return message ?? "The gateway returned an error (\(status))."
            case let .heavySession(contextTokens, _):
                return "This session is about \(contextTokens / 1000)k tokens - continuing will use a lot of your usage."
            case .decoding:
                return "The gateway sent back something unexpected."
            case let .transport(error):
                return Self.describeTransportError(error)
            }
        }

        /// Separate from the switch above because Swift's implicit-return switch expressions
        /// require every case to be a single expression - this one needs the `NSError` cast first.
        private static func describeTransportError(_ error: Error) -> String {
            let ns = error as NSError
            switch ns.code {
            case NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorTimedOut,
                NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
                return "Can't reach the PC. Check it's on and that this phone is on the same Tailscale network."
            default:
                return error.localizedDescription
            }
        }
    }

    // MARK: Health (no auth)

    struct HealthResponse: Decodable {
        let ok: Bool
        let name: String
        let uptimeSec: Int
    }

    func checkHealth() async throws -> HealthResponse {
        try await send(path: "/health", method: "GET", authenticated: false)
    }

    /// 404 on a gateway that predates the endpoint: the caller shows "not available yet".
    func pcStatus() async throws -> PCStatusResponse {
        try await send(path: "/v1/pc/status", method: "GET", authenticated: true)
    }

    func watches() async throws -> [WatchDTO] {
        let response: WatchListResponse = try await send(path: "/v1/watches", method: "GET", authenticated: true)
        return response.watches
    }

    // MARK: Pairing (no auth - the code itself is the credential, single use, 5 min TTL)

    struct PairResult: Decodable {
        let deviceId: String
        let token: String
    }

    func pair(code: String, deviceName: String, platform: String = "ios") async throws -> PairResult {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // A new pairing brings a fresh signing key; the gateway enrolls it with the device.
        // If it fails (wrong code), the old key is put back so an existing pairing keeps working.
        let previousKey = KeychainStore.get(.signingKey)
        DeviceSigner.ensureKey(replacing: true)
        let body = PairRequestBody(code: trimmed, deviceName: deviceName, platform: platform,
                                   publicKey: DeviceSigner.publicKeyBase64, keyProof: DeviceSigner.enrollmentProof())
        do {
            return try await send(path: "/v1/pair/complete", method: "POST", body: body, authenticated: false)
        } catch {
            DeviceSigner.restore(previousKey)
            throw error
        }
    }

    private struct PairRequestBody: Encodable {
        let code: String
        let deviceName: String
        let platform: String
        let publicKey: String?
        let keyProof: String?
    }

    // MARK: Request signing

    struct SigningStatus: Decodable {
        let enrolled: Bool
        let required: Bool
    }

    func signingStatus() async throws -> SigningStatus {
        try await send(path: "/v1/devices/me/key", method: "GET", authenticated: true)
    }

    /// Enrolls this phone's public key (an already-paired phone). This one call is sent with the
    /// bearer token only, since the gateway has no key to check a signature against yet.
    func enrollSigningKey() async throws {
        guard DeviceSigner.ensureKey(), let publicKey = DeviceSigner.publicKeyBase64,
              let proof = DeviceSigner.enrollmentProof() else { return }
        var request = try makeRequest(path: "/v1/devices/me/key", method: "PUT", query: [], authenticated: true)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["publicKey": publicKey, "keyProof": proof])
        let _: EnrollResult = try await perform(request, sign: false)
    }

    private struct EnrollResult: Decodable { let enrolled: Bool }

    // MARK: Presence (authenticated)

    func getPresence() async throws -> PresenceStatusDTO {
        try await send(path: "/v1/presence", method: "GET", authenticated: true)
    }

    private struct SetPresenceBody: Encodable { let mode: String }

    func setPresence(_ mode: PresenceMode) async throws -> PresenceStatusDTO {
        try await send(
            path: "/v1/presence", method: "PUT",
            body: SetPresenceBody(mode: mode.rawValue), authenticated: true
        )
    }

    // MARK: Agent sessions (authenticated) - GET /v1/agent-sessions

    struct AgentSessionsResponse: Decodable { let sessions: [AgentSessionInfoDTO] }

    func listAgentSessions(
        provider: Provider? = nil,
        live: Bool? = nil,
        query: String? = nil,
        project: String? = nil,
        limit: Int = 100
    ) async throws -> [AgentSessionInfoDTO] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let provider { items.append(URLQueryItem(name: "provider", value: provider.rawValue)) }
        if let live { items.append(URLQueryItem(name: "live", value: live ? "true" : "false")) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let project { items.append(URLQueryItem(name: "project", value: project)) }
        let response: AgentSessionsResponse = try await send(
            path: "/v1/agent-sessions", method: "GET", query: items, authenticated: true
        )
        return response.sessions
    }

    // MARK: Session history and continuation (authenticated)

    func sessionTranscript(provider: Provider, id: String, before: Int? = nil) async throws -> TranscriptPageDTO {
        var query = [URLQueryItem(name: "limit", value: "100")]
        if let before { query.append(URLQueryItem(name: "before", value: String(before))) }
        return try await send(path: "/v1/agent-sessions/\(provider.rawValue)/\(id)/transcript",
                              method: "GET", query: query, authenticated: true)
    }

    private struct AdoptBody: Encodable { let mode = "auto" }

    func adoptSession(provider: Provider, id: String) async throws -> AdoptedSessionDTO {
        try await send(path: "/v1/agent-sessions/\(provider.rawValue)/\(id)/adopt",
                       method: "POST", body: AdoptBody(), authenticated: true)
    }

    private struct SessionMessageBody: Encodable { let text: String; let confirmHeavy: Bool? }

    func sendSessionMessage(sessionID: String, text: String, confirmHeavy: Bool = false) async throws -> SendAccepted {
        try await send(path: "/v1/sessions/\(sessionID)/message", method: "POST",
                       body: SessionMessageBody(text: text, confirmHeavy: confirmHeavy ? true : nil), authenticated: true)
    }

    struct CostCheckDTO: Decodable {
        let heavy: Bool
        let contextTokens: Int?
        let reason: String?
    }

    /// `GET /v1/sessions/:id/cost-check` - lets the app warn before the user even types, instead
    /// of only finding out after a 409 on send.
    func costCheck(sessionID: String) async throws -> CostCheckDTO {
        try await send(path: "/v1/sessions/\(sessionID)/cost-check", method: "GET", authenticated: true)
    }

    func sessionMessages(sessionID: String) async throws -> [AgentMessageDTO] {
        var messages: [AgentMessageDTO] = []
        var after = 0
        while true {
            try Task.checkCancellation()
            let response: RouteMessagesResponse = try await send(
                path: "/v1/conversations/\(sessionID)/messages", method: "GET",
                query: [URLQueryItem(name: "limit", value: "500"), URLQueryItem(name: "after", value: String(after))],
                authenticated: true
            )
            messages += response.messages
            guard response.messages.count == 500 else { return messages }
            guard let next = response.messages.last?.seq, next > after else { throw ClientError.invalidResponse }
            after = next
        }
    }

    // MARK: Approvals (authenticated)

    struct ApprovalsResponse: Decodable { let approvals: [ApprovalDTO] }

    func listApprovals(status: ApprovalStatus? = nil, limit: Int = 100) async throws -> [ApprovalDTO] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let status { items.append(URLQueryItem(name: "status", value: status.rawValue)) }
        let response: ApprovalsResponse = try await send(
            path: "/v1/approvals", method: "GET", query: items, authenticated: true
        )
        return response.approvals
    }

    private struct ApprovalDecisionBody: Encodable {
        let note: String?
    }

    /// `POST /v1/approvals/:id/approve` or `.../reject`. Settles once: resolving an already-
    /// resolved approval just returns its current state, same as the server does.
    func resolveApproval(_ id: String, approve: Bool, note: String? = nil) async throws -> ApprovalDTO {
        try await send(
            path: "/v1/approvals/\(id)/\(approve ? "approve" : "reject")", method: "POST",
            body: ApprovalDecisionBody(note: note), authenticated: true
        )
    }

    // MARK: Routes - the General Claude / Astra front doors (authenticated)

    struct RoutesResponse: Decodable { let routes: [RouteDTO] }

    func listRoutes() async throws -> [RouteDTO] {
        let response: RoutesResponse = try await send(path: "/v1/routes", method: "GET", authenticated: true)
        return response.routes
    }

    /// A call gets its own fresh route (`POST /v1/calls/start` always creates one, unlike the
    /// reused front-door routes) - this fetches its current state right after, so the call's
    /// route can be tracked through `agent.speech`/`route.handoff` the same way a chat route is.
    func getRoute(_ id: String) async throws -> RouteDTO {
        try await send(path: "/v1/routes/\(id)", method: "GET", authenticated: true)
    }

    private struct CreateRouteBody: Encodable {
        let title: String?
        let provider: String
    }

    func createRoute(title: String? = nil, provider: Provider = .claude) async throws -> RouteDTO {
        try await send(
            path: "/v1/routes", method: "POST",
            body: CreateRouteBody(title: title, provider: provider.rawValue), authenticated: true
        )
    }

    struct SendAccepted: Decodable {
        let sessionId: String?
        let messageId: String
        let turnId: String
    }

    private struct RouteMessageBody: Encodable {
        let text: String
        let voice: Bool?
        let voiceSeverity: String?
        let engine: String?
        let confirmHeavy: Bool?
    }

    func sendRouteMessage(
        routeId: String, text: String, voice: Bool? = nil, voiceSeverity: String? = nil, engine: String? = nil,
        confirmHeavy: Bool = false
    ) async throws -> SendAccepted {
        try await send(
            path: "/v1/routes/\(routeId)/message", method: "POST",
            body: RouteMessageBody(
                text: text, voice: voice, voiceSeverity: voiceSeverity, engine: engine,
                confirmHeavy: confirmHeavy ? true : nil
            ),
            authenticated: true
        )
    }

    struct RouteMessagesResponse: Decodable { let messages: [AgentMessageDTO] }

    /// The route's merged history: every session it has ever been handed to, in order. This is
    /// what `conversationId` on each message means here - not the route's own id (see
    /// `AgentMessageDTO` and `pc-gateway/src/router/router.ts: messages()`).
    func routeMessages(routeId: String, after: Int = 0, limit: Int = 200) async throws -> [AgentMessageDTO] {
        var cursor = after
        var messages: [AgentMessageDTO] = []
        while true {
            try Task.checkCancellation()
            let items = [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(limit))]
            let response: RouteMessagesResponse = try await send(
                path: "/v1/routes/\(routeId)/messages", method: "GET", query: items, authenticated: true
            )
            messages += response.messages
            guard response.messages.count == limit else { return messages }
            guard let next = response.messages.last?.seq, next > cursor else { throw ClientError.invalidResponse }
            cursor = next
        }
    }

    struct InterruptedResponse: Decodable { let interrupted: Bool }

    func interruptRoute(_ routeId: String) async throws -> Bool {
        let response: InterruptedResponse = try await send(
            path: "/v1/routes/\(routeId)/interrupt", method: "POST", authenticated: true
        )
        return response.interrupted
    }

    func resetRoute(_ routeId: String) async throws -> RouteDTO {
        try await send(path: "/v1/routes/\(routeId)/reset", method: "POST", authenticated: true)
    }

    // MARK: Calls (authenticated) - docs/CALLS.md section 4, "the user calls Helix"

    private struct StartCallBody: Encodable {
        let sessionId: String?
        let title: String?
        let provider: String?
    }

    /// "Call Claude" (no args), "Call Astra" (`provider: .codex`), or call a specific session
    /// directly (`sessionId`). Already answered by the time this returns - an outgoing call has
    /// no ringing phase - with `script` as the greeting to speak once CallKit activates.
    func startCall(sessionId: String? = nil, title: String? = nil, provider: Provider? = nil) async throws -> CallDTO {
        try await send(
            path: "/v1/calls/start", method: "POST",
            body: StartCallBody(sessionId: sessionId, title: title, provider: provider?.rawValue),
            authenticated: true
        )
    }

    private struct EndCallBody: Encodable { let reason: String? }

    func endCall(_ id: String, reason: String? = nil) async throws -> CallDTO {
        try await send(
            path: "/v1/calls/\(id)/end", method: "POST", body: EndCallBody(reason: reason), authenticated: true
        )
    }

    // MARK: Push and incoming calls (authenticated) - docs/CALLS.md sections 1-3

    private struct PushTokenBody: Encodable {
        let kind: String
        let token: String
        let environment: String
        let bundleId: String
    }
    private struct Ack: Decodable {}

    /// `kind` is "alert" (the normal APNs token) or "voip" (the PushKit token). Safe to repeat;
    /// the gateway replaces the previous token for this device and kind.
    func registerPushToken(kind: String, token: String, environment: String, bundleId: String) async throws {
        let _: Ack = try await send(
            path: "/v1/devices/me/push-token", method: "PUT",
            body: PushTokenBody(kind: kind, token: token, environment: environment, bundleId: bundleId),
            authenticated: true
        )
    }

    func getCall(_ id: String) async throws -> CallDTO {
        try await send(path: "/v1/calls/\(id)", method: "GET", authenticated: true)
    }

    /// 409 means the call is no longer ringing (declined elsewhere, missed, or the approval was
    /// already resolved) - the caller should end the CallKit call.
    func answerCall(_ id: String) async throws -> CallDTO {
        try await send(path: "/v1/calls/\(id)/answer", method: "POST", body: EmptyBody(), authenticated: true)
    }

    func declineCall(_ id: String) async throws -> CallDTO {
        try await send(path: "/v1/calls/\(id)/decline", method: "POST", body: EmptyBody(), authenticated: true)
    }

    private struct Ignored: Decodable {}

    /// Starts loading the PC voice so it is ready by the time a call starts. Harmless and instant.
    func warmVoice() async {
        let _: Ignored? = try? await send(path: "/v1/voice/tts/warm", method: "POST", body: EmptyBody(), authenticated: true)
    }

    private struct EmptyBody: Encodable {}
    private struct DecisionBody: Encodable { let approve: Bool }
    struct CallDecisionDTO: Decodable {
        let call: CallDTO
        let approvalStatus: String?
    }

    /// Accepted once, on an answered approval call.
    func decideCall(_ id: String, approve: Bool) async throws -> CallDecisionDTO {
        try await send(path: "/v1/calls/\(id)/decision", method: "POST", body: DecisionBody(approve: approve), authenticated: true)
    }

    // MARK: Voice (authenticated) - speech recognizer hints and the instant spoken digest

    /// `SFSpeechAudioBufferRecognitionRequest.contextualStrings` - fetch when a call starts, it
    /// changes as sessions/watches come and go.
    func voiceHints() async throws -> [String] {
        let response: VoiceHintsDTO = try await send(path: "/v1/voice/hints", method: "GET", authenticated: true)
        return response.strings
    }

    /// An instant, model-free spoken status - good as the first thing said after the greeting.
    func digest(plain: Bool = false) async throws -> DigestDTO {
        let items = plain ? [URLQueryItem(name: "plain", value: "true")] : []
        return try await send(path: "/v1/digest", method: "GET", query: items, authenticated: true)
    }


    /// Raw bytes of a clip path from the gateway (`/v1/voice/clips/:id`).
    func clipData(path: String) async throws -> Data {
        try await rawGet(path: path).data
    }

    /// What Helix says when it calls you, in the PC voice. `nil` = none: speak `script` with Apple's voice.
    /// Polls while the gateway is still recording (202), up to about 4 s.
    func callScriptAudio(_ id: String) async -> Data? {
        for _ in 0..<9 {
            guard let result = try? await rawGet(path: "/v1/calls/\(id)/script-audio") else { return nil }
            switch result.status {
            case 200: return result.data
            case 202: try? await Task.sleep(for: .milliseconds(500))
            default: return nil
            }
        }
        return nil
    }

    private func rawGet(path: String) async throws -> (data: Data, status: Int) {
        var request = try makeRequest(path: path, method: "GET", query: [], authenticated: true)
        request.timeoutInterval = 20
        let (data, response) = try await urlSession.data(for: DeviceSigner.sign(request, deviceID: session.deviceID))
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        return (data, http.statusCode)
    }

    // MARK: Generic request

    private func send<Response: Decodable>(
        path: String,
        method: String,
        query: [URLQueryItem] = [],
        authenticated: Bool
    ) async throws -> Response {
        try await perform(makeRequest(path: path, method: method, query: query, authenticated: authenticated))
    }

    private func send<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        body: Body,
        authenticated: Bool
    ) async throws -> Response {
        var request = try makeRequest(path: path, method: method, query: [], authenticated: authenticated)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw ClientError.decoding(error)
        }
        return try await perform(request)
    }

    private func makeRequest(path: String, method: String, query: [URLQueryItem], authenticated: Bool) throws -> URLRequest {
        guard var components = URLComponents(url: session.baseURL, resolvingAgainstBaseURL: false) else {
            throw ClientError.invalidURL
        }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw ClientError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if authenticated {
            guard let token = session.deviceToken else { throw ClientError.notPaired }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func perform<Response: Decodable>(_ request: URLRequest, sign: Bool = true) async throws -> Response {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: sign ? DeviceSigner.sign(request, deviceID: session.deviceID) : request)
        } catch {
            print("GatewayClient: transport error for \(request.httpMethod ?? "?") \(request.url?.absoluteString ?? "?"): \(error)")
            throw ClientError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            print(
                "GatewayClient: \(http.statusCode) for \(request.httpMethod ?? "?") \(request.url?.absoluteString ?? "?") "
                    + "- body: \(String(data: data, encoding: .utf8) ?? "<non-utf8>")"
            )
            if http.statusCode == 409, body?.code == "heavy_session", let tokens = body?.contextTokens {
                throw ClientError.heavySession(contextTokens: tokens, reason: body?.reason ?? "cold")
            }
            throw ClientError.http(status: http.statusCode, message: body?.error)
        }

        do {
            // Every gateway timestamp needs the fractional-seconds-aware ISO 8601 decoding;
            // harmless for responses (like pairing/health) that have no date fields at all.
            return try JSONDecoder.gateway.decode(Response.self, from: data)
        } catch {
            throw ClientError.decoding(error)
        }
    }

    private struct ErrorBody: Decodable {
        let error: String
        let code: String?
        let contextTokens: Int?
        let reason: String?
    }
}

import Foundation

/// One persistent connection to `WS /v1/ws`. The gateway pushes every event to every connected
/// device (single-user system - pc-gateway/src/api/websocket.ts), so there is nothing to
/// subscribe to beyond connecting; `onEvent` fires for each one. Reconnects with backoff on any
/// drop as long as `connect()` was called more recently than `disconnect()`.
///
/// Main-actor-isolated like the rest of this project (`SWIFT_DEFAULT_ACTOR_ISOLATION =
/// MainActor`); only the two `URLSessionWebSocketDelegate` methods below are `nonisolated` (that
/// protocol's requirements are not actor-isolated) and hop back to the main actor themselves.
final class GatewayWebSocket: NSObject {
    private let gatewaySession: GatewaySession
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var shouldReconnect = false

    private(set) var isConnected = false
    var onEvent: ((GatewayEvent) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    init(session: GatewaySession) {
        self.gatewaySession = session
    }

    func connect() {
        guard let token = gatewaySession.deviceToken else { return }
        guard task == nil, reconnectTask == nil else { return }
        shouldReconnect = true
        reconnectTask?.cancel()
        openSocket(token: token)
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        reconnectTask = nil
        setConnected(false)
    }

    private func openSocket(token: String) {
        guard var components = URLComponents(url: gatewaySession.baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/ws"
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request = DeviceSigner.sign(request, deviceID: gatewaySession.deviceID)

        let urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.urlSession = urlSession
        let task = urlSession.webSocketTask(with: request)
        self.task = task
        task.resume()
        listen(on: task)
    }

    private func listen(on task: URLSessionWebSocketTask) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    self?.handle(message)
                } catch {
                    if self?.task === task { self?.scheduleReconnect() }
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: return
        }
        guard let event = try? JSONDecoder.gateway.decode(GatewayEvent.self, from: data) else { return }
        onEvent?(event)
    }

    private func scheduleReconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        setConnected(false)
        guard shouldReconnect, let token = gatewaySession.deviceToken else { return }
        reconnectAttempt += 1
        let delay = min(30.0, pow(2.0, Double(reconnectAttempt)))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, self.shouldReconnect, !Task.isCancelled else { return }
            self.reconnectTask = nil
            self.openSocket(token: token)
        }
    }

    private func setConnected(_ connected: Bool) {
        isConnected = connected
        onConnectionChange?(connected)
    }

    // MARK: Sending

    /// Mirrors the server's `clientMessage` discriminated union (api/websocket.ts).
    enum ClientMessage: Encodable {
        case send(sessionId: String, text: String, clientId: String? = nil)
        case interrupt(sessionId: String)
        case routeSend(routeId: String, text: String, clientId: String? = nil, voice: Bool? = nil)
        case routeInterrupt(routeId: String)
        case ping

        private enum CodingKeys: String, CodingKey {
            case type, sessionId, text, clientId, routeId, voice
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .send(sessionId, text, clientId):
                try container.encode("send", forKey: .type)
                try container.encode(sessionId, forKey: .sessionId)
                try container.encode(text, forKey: .text)
                try container.encodeIfPresent(clientId, forKey: .clientId)
            case let .interrupt(sessionId):
                try container.encode("interrupt", forKey: .type)
                try container.encode(sessionId, forKey: .sessionId)
            case let .routeSend(routeId, text, clientId, voice):
                try container.encode("route.send", forKey: .type)
                try container.encode(routeId, forKey: .routeId)
                try container.encode(text, forKey: .text)
                try container.encodeIfPresent(clientId, forKey: .clientId)
                try container.encodeIfPresent(voice, forKey: .voice)
            case let .routeInterrupt(routeId):
                try container.encode("route.interrupt", forKey: .type)
                try container.encode(routeId, forKey: .routeId)
            case .ping:
                try container.encode("ping", forKey: .type)
            }
        }
    }

    func send(_ message: ClientMessage) {
        guard let task else { return }
        guard let data = try? JSONEncoder().encode(message), let string = String(data: data, encoding: .utf8) else { return }
        task.send(.string(string)) { _ in }
    }
}

extension GatewayWebSocket: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor [weak self] in
            guard self?.task === webSocketTask else { return }
            self?.reconnectAttempt = 0
            self?.setConnected(true)
        }
    }

    nonisolated func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        // The receive loop's `task.receive()` also throws on close and schedules the actual
        // reconnect; this just keeps `isConnected` accurate the moment the close happens rather
        // than waiting for that throw to propagate.
        Task { @MainActor [weak self] in
            if self?.task === webSocketTask { self?.setConnected(false) }
        }
    }
}

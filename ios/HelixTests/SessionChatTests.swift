import Foundation
import Testing
@testable import Helix

private nonisolated final class ChatGatewayProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var respond: (@Sendable (URLRequest) -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, json) = Self.respond!(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized)
struct SessionChatTests {
    private let discovery = #"{"sessions":[{"key":"codex:native","provider":"codex","id":"native","title":"Real PC chat","messageCount":2,"live":true,"managed":false,"projectName":"Helix"}]}"#
    private let history = #"{"messages":[{"index":0,"role":"user","text":"Original question","ts":"2026-10-02T12:00:00.000Z"},{"index":1,"role":"tool","text":"Hidden tool"},{"index":2,"role":"assistant","text":"Original answer","ts":"2026-10-02T12:00:01Z"}],"total":3,"hasMore":false}"#
    private let adoption = #"{"session":{"id":"managed","provider":"codex","providerSessionId":"fork-native","title":"Real PC chat (fork)","status":"idle"},"mode":"fork"}"#

    private func store(defaults: UserDefaults? = nil) -> HelixStore {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatGatewayProtocol.self]
        return HelixStore(
            gatewaySession: GatewaySession(baseURL: URL(string: "https://gateway.invalid")!, deviceToken: "test-only", deviceID: "test"),
            urlSession: URLSession(configuration: config),
            defaults: defaults ?? UserDefaults(suiteName: "HelixChatTests.\(UUID().uuidString)")!
        )
    }

    @Test func viewingHistoryDoesNotAdoptOrSend() async throws {
        let discovery = discovery, history = history
        ChatGatewayProtocol.respond = { request in
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
            return (200, request.url!.path == "/v1/agent-sessions" ? discovery : history)
        }
        let store = store()
        #expect(store.conversations.isEmpty)
        await store.syncAgentSessions()
        let id = store.sessionConversationID(try #require(store.sessions.first))
        await store.loadConversation(id)
        #expect(store.conversation(id: id)?.messages.map(\.text) == ["Original question", "Original answer"])
        #expect(store.canSend(to: id))
    }

    @Test func firstSendAdoptsAndLiveRepliesAreDeduplicated() async throws {
        let discovery = discovery, history = history, adoption = adoption
        ChatGatewayProtocol.respond = { request in
            switch request.url!.path {
            case "/v1/agent-sessions": return (200, discovery)
            case "/v1/agent-sessions/native/transcript", "/v1/agent-sessions/codex/native/transcript",
                 "/v1/agent-sessions/codex/fork-native/transcript": return (200, history)
            case "/v1/agent-sessions/codex/native/adopt":
                #expect(request.httpMethod == "POST")
                return (201, adoption)
            case "/v1/sessions/managed/message":
                #expect(request.httpMethod == "POST")
                // The real session endpoint intentionally has no sessionId in its acknowledgement.
                return (202, #"{"messageId":"sent","turnId":"turn"}"#)
            case "/v1/conversations/managed/messages": return (200, #"{"messages":[]}"#)
            default: return (404, #"{"error":"Unexpected endpoint"}"#)
            }
        }
        let defaults = UserDefaults(suiteName: "HelixChatTests.\(UUID().uuidString)")!
        let store = store(defaults: defaults)
        await store.syncAgentSessions()
        let id = "session:codex:native"
        await store.loadConversation(id)
        #expect(await store.send("Continue", to: id))
        #expect(store.chatNotices[id]?.contains("fork") == true)
        #expect(store.conversation(id: id)?.messages.filter { $0.text == "Continue" }.count == 1)
        store.handle(.agentOutputDelta(sessionId: "managed", turnId: "turn", text: "Live "))
        store.handle(.agentOutputDelta(sessionId: "managed", turnId: "turn", text: "reply"))
        #expect(store.streamingReplies[id] == "Live reply")
        let event = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(#"{"type":"message.created","message":{"seq":2,"id":"answer","conversationId":"managed","sender":"agent","type":"text","severity":"info","text":"Live reply","createdAt":"2026-10-02T12:05:00.123Z"}}"#.utf8))
        store.handle(event)
        store.handle(event)
        #expect(store.conversation(id: id)?.messages.filter { $0.id == "answer" }.count == 1)
        #expect(!store.typingConversationIDs.contains(id))
        #expect(store.streamingReplies[id] == nil)
        let reopened = self.store(defaults: defaults)
        await reopened.syncAgentSessions()
        #expect(reopened.chatNotices[id]?.contains("fork") == true)
    }

    @Test func failedSendShowsErrorWithoutInventingAReply() async throws {
        let discovery = discovery, adoption = adoption
        ChatGatewayProtocol.respond = { request in
            switch request.url!.path {
            case "/v1/agent-sessions": return (200, discovery)
            case "/v1/agent-sessions/codex/native/adopt": return (201, adoption)
            default: return (409, #"{"error":"session is already running"}"#)
            }
        }
        let store = store()
        await store.syncAgentSessions()
        let id = "session:codex:native"
        #expect(await store.send("Keep this draft", to: id) == false)
        #expect(store.conversation(id: id)?.messages.isEmpty == true)
        #expect(store.chatErrors[id]?.contains("draft is saved") == true)
        #expect(!store.sendingConversationIDs.contains(id))
        #expect(!store.typingConversationIDs.contains(id))
    }

    @Test func ledgerRecoveryCompletesAReplyWithoutTheSocket() async {
        let discovery = discovery, adoption = adoption, history = history
        ChatGatewayProtocol.respond = { request in
            switch request.url!.path {
            case "/v1/agent-sessions": return (200, discovery)
            case "/v1/agent-sessions/codex/native/adopt": return (201, adoption)
            case "/v1/sessions/managed/message": return (202, #"{"messageId":"sent","turnId":"turn"}"#)
            case "/v1/conversations/managed/messages":
                return (200, #"{"messages":[{"seq":1,"id":"sent","conversationId":"managed","sender":"user","type":"text","severity":"info","text":"Continue","createdAt":"2026-10-02T12:05:00Z"},{"seq":2,"id":"reply","conversationId":"managed","sender":"agent","type":"text","severity":"info","text":"Recovered reply","createdAt":"2026-10-02T12:05:01Z"}]}"#)
            default: return (200, history)
            }
        }
        let store = store()
        await store.syncAgentSessions()
        let id = "session:codex:native"
        #expect(await store.send("Continue", to: id))
        #expect(store.typingConversationIDs.contains(id))
        await store.loadConversation(id)
        #expect(store.conversation(id: id)?.messages.last?.text == "Recovered reply")
        #expect(store.conversation(id: id)?.messages.filter { $0.text == "Continue" }.count == 1)
        #expect(!store.typingConversationIDs.contains(id))
        #expect(store.canSend(to: id))
    }

    @Test func openingAFrontDoorResetsTheRouteOnTheServer() async throws {
        let routeAfterHandoff = #"{"routes":[{"id":"claude-route","title":"General Claude","frontDoor":"claude","routerSessionId":"router","targetSessionId":"elsewhere","currentSessionId":"elsewhere","visited":["router","elsewhere"],"createdAt":"2026-10-02T12:00:00Z","updatedAt":"2026-10-02T12:00:00Z"}]}"#
        let routeReset = #"{"id":"claude-route","title":"General Claude","frontDoor":"claude","routerSessionId":"router","currentSessionId":"router","visited":["router","elsewhere"],"createdAt":"2026-10-02T12:00:00Z","updatedAt":"2026-10-02T12:05:00Z"}"#
        final class ResetFlag: @unchecked Sendable { nonisolated(unsafe) var hit = false }
        let resetWasCalled = ResetFlag()
        ChatGatewayProtocol.respond = { request in
            switch (request.httpMethod, request.url!.path) {
            case ("GET", "/v1/routes"): return (200, routeAfterHandoff)
            case ("GET", "/v1/routes/claude-route/messages"): return (200, #"{"messages":[]}"#)
            case ("POST", "/v1/routes/claude-route/reset"):
                resetWasCalled.hit = true
                return (200, routeReset)
            default: return (404, #"{"error":"Unexpected endpoint"}"#)
            }
        }
        let store = store()
        await store.ensureFrontDoorRoutes()
        let id = try #require(store.frontDoorConversations.first { $0.provider == .claude }?.id)

        store.resetFrontDoorConversation(id)
        #expect(store.conversation(id: id)?.messages.isEmpty == true)

        // The reset POST is fire-and-forget; give its Task a moment to land.
        try await Task.sleep(for: .milliseconds(50))
        #expect(resetWasCalled.hit)
    }

    @Test func internalHarnessNoiseIsHiddenFromTheChat() async throws {
        let discovery = discovery
        let historyWithNoise = #"{"messages":[{"index":0,"role":"user","text":"<task-notification><task-id>a</task-id><status>stopped</status></task-notification>","ts":"2026-10-02T12:00:00Z"},{"index":1,"role":"assistant","text":"I'll check what's running.","ts":"2026-10-02T12:00:01Z"}],"total":2,"hasMore":false}"#
        ChatGatewayProtocol.respond = { request in
            request.url!.path == "/v1/agent-sessions" ? (200, discovery) : (200, historyWithNoise)
        }
        let store = store()
        await store.syncAgentSessions()
        let id = "session:codex:native"
        await store.loadConversation(id)
        #expect(store.conversation(id: id)?.messages.map(\.text) == ["I'll check what's running."])
    }

    @Test func terminalHandoffIsAPlainConnectWithNoForkNotice() async throws {
        let oneRoute = #"{"routes":[{"id":"claude-route","title":"General Claude","frontDoor":"claude","routerSessionId":"router","currentSessionId":"router","visited":["router"],"createdAt":"2026-10-02T12:00:00Z","updatedAt":"2026-10-02T12:00:00Z"}]}"#
        ChatGatewayProtocol.respond = { request in
            switch (request.httpMethod, request.url!.path) {
            case ("GET", "/v1/routes"): return (200, oneRoute)
            case ("GET", "/v1/routes/claude-route/messages"): return (200, #"{"messages":[]}"#)
            default: return (404, #"{"error":"Unexpected endpoint"}"#)
            }
        }
        let store = store()
        await store.ensureFrontDoorRoutes()
        let id = try #require(store.frontDoorConversations.first { $0.provider == .claude }?.id)

        // The gateway's new `mode: "terminal"` (a live terminal session answered through its
        // inbox, never forked) must decode and behave like any plain connect.
        let event = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(#"{"type":"route.handoff","routeId":"claude-route","fromSessionId":"router","toSessionId":"terminal-session","toTitle":"Helix work","mode":"terminal"}"#.utf8))
        store.handle(event)

        #expect(store.conversation(id: id)?.title == "Helix work")
        #expect(store.chatNotices[id] == nil)
    }

    @Test func handoffUpdatesTheFrontDoorTitleToWhosAnsweringNow() async throws {
        let oneRoute = #"{"routes":[{"id":"claude-route","title":"General Claude","frontDoor":"claude","routerSessionId":"router","currentSessionId":"router","visited":["router"],"createdAt":"2026-10-02T12:00:00Z","updatedAt":"2026-10-02T12:00:00Z"}]}"#
        ChatGatewayProtocol.respond = { request in
            switch (request.httpMethod, request.url!.path) {
            case ("GET", "/v1/routes"): return (200, oneRoute)
            case ("GET", "/v1/routes/claude-route/messages"): return (200, #"{"messages":[]}"#)
            case ("POST", "/v1/routes/claude-route/message"):
                return (202, #"{"sessionId":"router","messageId":"m1","turnId":"t1"}"#)
            default: return (404, #"{"error":"Unexpected endpoint"}"#)
            }
        }
        let store = store()
        await store.ensureFrontDoorRoutes()
        let id = try #require(store.frontDoorConversations.first { $0.provider == .claude }?.id)
        #expect(store.conversation(id: id)?.title == "Claude")
        #expect(await store.send("connect me to the helix claude agent", to: id))
        #expect(store.typingConversationIDs.contains(id))

        store.handle(.routeHandoff(
            routeId: id, fromSessionId: "router", toSessionId: "specific-project",
            toTitle: "Data pipeline v2 cleanup script", mode: "fork"
        ))

        #expect(store.conversation(id: id)?.title == "Data pipeline v2 cleanup script")
        // A silent connect-only handoff (routing-only.ts) can complete with no further
        // message.created at all - "typing" must not be left stuck true, which otherwise made
        // the Chats list keep showing "Typing…" until the chat was reopened.
        #expect(!store.typingConversationIDs.contains(id))
        #expect(store.canSend(to: id))
    }

    @Test func earlierHistoryUsesTheProviderOrdinalCursor() async {
        let discovery = discovery
        ChatGatewayProtocol.respond = { request in
            if request.url!.path == "/v1/agent-sessions" { return (200, discovery) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            if let before = query.first(where: { $0.name == "before" }) {
                #expect(before.value == "100")
                return (200, #"{"messages":[{"index":0,"role":"user","text":"Earlier"}],"total":101,"hasMore":false}"#)
            }
            return (200, #"{"messages":[{"index":100,"role":"assistant","text":"Latest"}],"total":101,"hasMore":true}"#)
        }
        let store = store()
        await store.syncAgentSessions()
        let id = "session:codex:native"
        await store.loadConversation(id)
        #expect(store.hasMoreHistory.contains(id))
        await store.loadConversation(id, older: true)
        #expect(store.conversation(id: id)?.messages.map(\.text) == ["Earlier", "Latest"])
        #expect(!store.hasMoreHistory.contains(id))
    }
}

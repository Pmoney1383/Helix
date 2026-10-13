import Foundation
import Testing
@testable import Helix

struct HelixStoreTests {
    @Test func approvingMovesAnItemOutOfPending() throws {
        let store = HelixStore()
        let first = try #require(store.pendingApprovals.first)

        store.approve(first.id)

        #expect(!store.pendingApprovals.contains { $0.id == first.id })
        #expect(store.approvals.first { $0.id == first.id }?.status == .approved)
        #expect(store.approvals.first { $0.id == first.id }?.resolvedAt != nil)
    }

    @Test func resolvedApprovalsCannotBeResolvedAgain() throws {
        let store = HelixStore()
        let first = try #require(store.pendingApprovals.first)

        store.reject(first.id)
        store.approve(first.id)

        #expect(store.approvals.first { $0.id == first.id }?.status == .rejected)
    }

    @Test func recentConversationsAreNewestFirst() {
        let store = HelixStore()
        let dates = store.recentConversations.map(\.lastActivityAt)
        #expect(dates == dates.sorted(by: >))
        #expect(store.recentConversations.first?.id == "training")
    }

    @Test func unpairedChatsNeverSendOrProduceSampleReplies() async {
        let store = HelixStore(gatewaySession: GatewaySession(baseURL: URL(string: "https://example.invalid")!, deviceToken: nil))
        let before = store.conversation(id: "planning")!.messages.count

        #expect(await store.send("   ", to: "planning") == false)
        #expect(store.conversation(id: "planning")!.messages.count == before)

        #expect(await store.send("Ship it", to: "planning") == false)
        #expect(store.conversation(id: "planning")!.messages.count == before)
        #expect(!store.typingConversationIDs.contains("planning"))
        #expect(store.chatErrors["planning"] != nil)
    }

    @Test func resettingAFrontDoorConversationClearsItsScrollback() {
        let store = HelixStore()
        #expect(!store.conversation(id: "general-claude")!.messages.isEmpty)

        store.resetFrontDoorConversation("general-claude")

        #expect(store.conversation(id: "general-claude")!.messages.isEmpty)
        // Not a front door: untouched.
        #expect(!store.conversation(id: "planning")!.messages.isEmpty)
    }

    @Test func emptyFrontDoorsStayOutOfTheChatsListUntilUsed() {
        let store = HelixStore()
        // Untouched (sample data starts both front doors with messages - simulate a fresh reset).
        store.resetFrontDoorConversation("general-claude")
        #expect(!store.visibleConversations.contains { $0.id == "general-claude" })
        // Still has sample messages: visible.
        #expect(store.visibleConversations.contains { $0.id == "astra" })
        // A real session chat is never hidden, empty or not.
        #expect(store.visibleConversations.contains { $0.id == "planning" })
    }

    @Test func endingACallLogsIt() {
        let store = HelixStore()
        let before = store.calls.count

        store.startCall(.codex)
        #expect(store.activeCall?.title == "Astra")
        store.endCall()

        #expect(store.activeCall == nil)
        #expect(store.calls.count == before + 1)
        #expect(store.calls.first?.provider == .codex)
    }

    @Test func choosingAPersonaModeAppliesItsPreset() {
        var persona = SampleData.persona
        persona.apply(.flirty)
        #expect(persona.mode == .flirty)
        #expect(persona.flirtiness == 0.85)
    }
}

struct TimeFormattingTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    nonisolated static let relativeCases: [(secondsAgo: Double, expected: String)] = [
        (30, "now"),
        (480, "8m ago"),
        (8_040, "2h 14m ago"),
        (7_200, "2h ago"),
        (22_200, "6h ago"),
        (108_000, "yesterday"),
        (270_000, "3d ago"),
    ]

    @Test(arguments: relativeCases)
    func relative(secondsAgo: Double, expected: String) {
        #expect(RelativeTime.short(from: now.addingTimeInterval(-secondsAgo), to: now) == expected)
    }

    @Test func durations() {
        #expect(DurationText.short(84 * 60) == "1h 24m")
        #expect(DurationText.short(12 * 60) == "12m")
        #expect(DurationText.short(-5) == "0m")
        #expect(DurationText.clock(252) == "4:12")
        #expect(DurationText.clock(3_729) == "1:02:09")
    }
}

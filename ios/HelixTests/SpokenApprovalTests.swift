import Testing
@testable import Helix

struct SpokenApprovalTests {
    @Test func clearWordsAreRecognised() {
        #expect(SpokenApproval.decision(from: "Approve") == .approve)
        #expect(SpokenApproval.decision(from: "yes go ahead") == .approve)
        #expect(SpokenApproval.decision(from: "Reject it.") == .reject)
        #expect(SpokenApproval.decision(from: "no, stop") == .reject)
    }

    @Test func ambiguityNeverDecides() {
        #expect(SpokenApproval.decision(from: "yes no wait") == .unclear)
        #expect(SpokenApproval.decision(from: "don't approve") == .unclear)
        #expect(SpokenApproval.decision(from: "I know") == .unclear)
        #expect(SpokenApproval.decision(from: "") == .unclear)
    }

    @Test func nothingIsSentWithoutConfirmation() {
        var flow = SpokenApproval()
        #expect(flow.hear("approve") == .say("I heard approve. Say confirm to allow it, or cancel to go back."))
        #expect(flow.phase == .awaitingConfirmation(approve: true))
        #expect(flow.hear("hmm maybe") != nil)
        #expect(flow.phase == .awaitingConfirmation(approve: true))
        #expect(flow.hear("confirm") == .send(approve: true))
        #expect(flow.hear("approve") == nil)
    }

    @Test func cancelGoesBackAndRejectConfirms() {
        var flow = SpokenApproval()
        _ = flow.hear("approve")
        _ = flow.hear("cancel")
        #expect(flow.phase == .awaitingDecision)
        _ = flow.hear("reject")
        #expect(flow.hear("yes confirm") == .send(approve: false))
    }
}

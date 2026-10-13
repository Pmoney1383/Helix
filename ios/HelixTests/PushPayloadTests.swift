import Foundation
import Testing
@testable import Helix

struct PushPayloadTests {
    @Test func voipPayloadFromContract() {
        let push = IncomingCallPush(payload: [
            "callId": "c1", "caller": "Claude", "title": "Training crashed", "expects": "approval",
            "helix": ["callId": "c1", "approvalId": "a9", "severity": "critical"],
        ])
        #expect(push == IncomingCallPush(payload: ["callId": "c1", "caller": "Claude", "title": "Training crashed", "expects": "approval", "helix": ["approvalId": "a9"]]))
        #expect(push?.approvalID == "a9")
        #expect(push?.expects == "approval")
    }

    @Test func voipPayloadWithoutCallIdIsNilButCallerDefaults() {
        #expect(IncomingCallPush(payload: ["caller": "Claude"]) == nil)
        #expect(IncomingCallPush(payload: ["helix": ["callId": "x"]])?.caller == "Claude")
    }

    @Test func alertPayload() {
        let alert = AlertPush(userInfo: ["aps": [:], "helix": ["kind": "approval", "approvalId": "a1", "sessionId": "s1"]])
        #expect(alert?.kind == .approval)
        #expect(alert?.approvalID == "a1")
        #expect(AlertPush(userInfo: ["helix": ["kind": "missed_call"]])?.kind == .missedCall)
        #expect(AlertPush(userInfo: ["helix": ["kind": "unknown"]]) == nil)
    }

    @Test func tokenIsLowercaseHex() {
        #expect(PushToken.hex(Data([0x0A, 0xFF, 0x01])) == "0aff01")
    }
}

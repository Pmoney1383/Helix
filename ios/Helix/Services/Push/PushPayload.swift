import Foundation

/// What a VoIP push (docs/CALLS.md section 3) says about the incoming call. Everything here is
/// only enough to ring and show a name: the real details come from `POST /v1/calls/:id/answer`.
struct IncomingCallPush: Equatable {
    var callID: String
    var caller: String
    var title: String
    var expects: String
    var approvalID: String?

    /// Nil only if the push carries no call id at all; it still has to be reported to CallKit
    /// (Apple's rule), the caller shows a placeholder and the answer step will fail cleanly.
    init?(payload: [AnyHashable: Any]) {
        let helix = payload["helix"] as? [String: Any]
        guard let id = (payload["callId"] as? String) ?? (helix?["callId"] as? String), !id.isEmpty else { return nil }
        callID = id
        let name = (payload["caller"] as? String) ?? ""
        caller = name.isEmpty ? "Claude" : name
        title = (payload["title"] as? String) ?? ""
        expects = (payload["expects"] as? String) ?? (helix?["expects"] as? String) ?? "conversation"
        approvalID = helix?["approvalId"] as? String
    }
}

/// The `helix` block of an ordinary notification (docs/CALLS.md section 2).
struct AlertPush: Equatable {
    enum Kind: String { case event, approval, missedCall = "missed_call" }

    var kind: Kind
    var sessionID: String?
    var approvalID: String?

    nonisolated init?(userInfo: [AnyHashable: Any]) {
        guard let helix = userInfo["helix"] as? [String: Any],
              let raw = helix["kind"] as? String, let kind = Kind(rawValue: raw) else { return nil }
        self.kind = kind
        sessionID = helix["sessionId"] as? String
        approvalID = helix["approvalId"] as? String
    }
}

enum PushToken {
    /// APNs wants lowercase hex, 32 to 200 characters (the gateway validates the same).
    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// Xcode/development-profile builds use Apple's sandbox push servers; TestFlight and App
    /// Store builds (which carry no embedded provisioning profile) use production. A token sent
    /// to the wrong one is rejected by Apple and the gateway marks it dead.
    static var environment: String {
        Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil ? "sandbox" : "production"
    }
}

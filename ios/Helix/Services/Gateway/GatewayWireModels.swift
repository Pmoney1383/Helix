import Foundation

// Decodable mirrors of the gateway's real wire shapes (pc-gateway/src/types.ts,
// router/router.ts, discovery/indexer.ts), kept separate from the UI-facing types in
// GatewayModels.swift on purpose: the server's optionality and field set don't always match
// what a screen wants to bind to, and a silent mismatch here should fail a decode, not quietly
// show wrong data. HelixStore maps these into the UI types.

extension JSONDecoder {
    /// Gateway timestamps are `Date().toISOString()` - ISO 8601 with milliseconds
    /// ("2026-10-02T12:34:56.789Z"). The default `.iso8601` strategy rejects the fractional
    /// part, so this tries that first and falls back to whole seconds.
    static let gateway: JSONDecoder = {
        let decoder = JSONDecoder()
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let wholeSeconds = ISO8601DateFormatter()
        wholeSeconds.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = withFractional.date(from: string) ?? wholeSeconds.date(from: string) {
                return date
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(string)")
        }
        return decoder
    }()
}

/// Mirrors `AgentSessionInfo` (discovery/indexer.ts): any Claude or Codex session on the PC,
/// gateway-managed or not. `GET /v1/agent-sessions` and the `agent.session.changed` event.
struct AgentSessionInfoDTO: Decodable, Identifiable, Hashable {
    var key: String
    var provider: Provider
    var id: String
    var title: String
    var projectPath: String?
    var projectName: String?
    var gitBranch: String?
    var model: String?
    var createdAt: Date?
    var lastActivityAt: Date?
    var messageCount: Int
    var preview: String?
    var lastUser: String?
    var lastUserAt: Date?
    var lastAssistant: String?
    var live: Bool
    var liveStatus: LiveStatus?
    var livePid: Int?
    var liveName: String?
    var liveKind: String?
    var liveSinceMs: Int?
    var liveInferred: Bool?
    var managed: Bool
    var helixSessionId: String?
}

/// Mirrors `Route` (router/router.ts): one phone conversation, General Claude or Astra, and
/// whichever session is currently answering it.
struct RouteDTO: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var frontDoor: Provider
    var routerSessionId: String
    var targetSessionId: String?
    var currentSessionId: String
    /// Every session this conversation has touched, in order - what a message's `conversationId`
    /// is checked against when deciding which route it belongs to (see `AgentMessageDTO`).
    var visited: [String]
    var createdAt: Date
    var updatedAt: Date
}

/// Mirrors `AgentMessage` (types.ts). `conversationId` is the underlying **session** id, not a
/// route id - a route's history spans several sessions (`RouteDTO.visited`), so matching a
/// message to a route means checking membership in `visited`, not equality with the route's id.
struct AgentMessageDTO: Decodable, Identifiable, Hashable {
    var seq: Int
    var id: String
    var conversationId: String
    var sessionId: String?
    var provider: Provider?
    var sender: MessageSender
    var type: String
    var severity: Severity
    var text: String
    var createdAt: Date
}

struct ManagedSessionDTO: Codable {
    var id: String
    var provider: Provider
    var providerSessionId: String
    var title: String
    var status: String
}

struct AdoptedSessionDTO: Decodable {
    var session: ManagedSessionDTO
    var mode: String
    var note: String?
}

struct TranscriptPageDTO: Decodable {
    struct Message: Decodable {
        var index: Int
        var role: String
        var text: String
        var ts: Date?
        var tool: String?
    }
    var messages: [Message]
    var total: Int
    var hasMore: Bool
}

/// Mirrors `Approval` (types.ts; built by `permissions/approvals.ts`). `status` reuses the UI's
/// own `ApprovalStatus` enum directly - the raw string cases are identical, so no separate wire
/// enum is needed. `sessionTitle` isn't on the wire at all (the server only has `sessionId`);
/// HelixStore resolves it against the synced session list when mapping to the UI type.
struct ApprovalDTO: Decodable, Identifiable, Hashable {
    var id: String
    var sessionId: String?
    var source: String
    var tool: String
    var summary: String
    var reasons: [String]
    var status: ApprovalStatus
    var createdAt: Date
    var expiresAt: Date
    var resolvedAt: Date?
    var resolvedBy: String?
    var note: String?
}

/// Mirrors `PresenceStatus` (notifications/presence.ts). `mode` reuses the UI's own
/// `PresenceMode` enum directly (identical raw cases). The rest (`away`, `reason`,
/// `reporterActive`, `idleSec`, `awayAfterMin`) is the actual decision and why - worth keeping
/// even though the Settings screen only binds `mode` today, since "away" can differ from what
/// `mode` alone suggests (e.g. `auto` + idle-helper not running = always away).
struct PresenceStatusDTO: Decodable, Hashable {
    var mode: PresenceMode
    var away: Bool
    var reason: String
    var idleSec: Int?
    var reporterActive: Bool
    var awayAfterMin: Int

    // `PresenceMode` (GatewayModels.swift) isn't Decodable (it has no wire-decoding need of its
    // own elsewhere), so this decodes the raw string and converts rather than adding Codable
    // conformance to a UI type for the sake of one field here.
    private enum CodingKeys: String, CodingKey { case mode, away, reason, idleSec, reporterActive, awayAfterMin }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawMode = try container.decode(String.self, forKey: .mode)
        guard let mode = PresenceMode(rawValue: rawMode) else {
            throw DecodingError.dataCorruptedError(forKey: .mode, in: container, debugDescription: "Unknown presence mode: \(rawMode)")
        }
        self.mode = mode
        away = try container.decode(Bool.self, forKey: .away)
        reason = try container.decode(String.self, forKey: .reason)
        idleSec = try container.decodeIfPresent(Int.self, forKey: .idleSec)
        reporterActive = try container.decode(Bool.self, forKey: .reporterActive)
        awayAfterMin = try container.decode(Int.self, forKey: .awayAfterMin)
    }
}

/// Mirrors `Call` (types.ts; built by `calls/call-manager.ts`). `direction`/`status`/`severity`
/// reuse the UI's own enums directly - all three are already `Codable` with matching raw values.
struct CallDTO: Decodable, Identifiable, Hashable {
    var id: String
    var direction: CallDirection
    var status: CallStatus
    var severity: Severity
    var title: String
    var summary: String
    /// What to say first once connected - for an outgoing call, the greeting (already in the
    /// user's persona). Empty string, not nil, when there's nothing to say.
    var script: String
    var expects: String
    var sessionId: String?
    var approvalId: String?
    /// Set once answered (outgoing calls: immediately) - the conversation to speak into.
    var routeId: String?
    /// Outgoing calls only: how long to play the ringback (1000...3000) before speaking the greeting.
    var ringbackMs: Int?
    /// Outgoing calls: the greeting pre-recorded in the PC voice (play it instead of speaking `script`).
    var scriptClip: ClipDTO?
    var deviceId: String?
    var createdAt: Date
    var answeredAt: Date?
    var endedAt: Date?
}

/// A pre-recorded line in the PC voice; `url` is a gateway path serving a wav.
struct ClipDTO: Decodable, Hashable {
    var id: String
    var seconds: Double
    var url: String
}

/// `GET /v1/voice/hints` -> `SFSpeechAudioBufferRecognitionRequest.contextualStrings`.
struct VoiceHintsDTO: Decodable {
    var strings: [String]
}

/// `GET /v1/digest` - an instant, model-free spoken status, already worded in the user's
/// persona (dialled down by `kind` on the server). Good as the first thing said after the
/// greeting, before any real reply has to wait on the model.
struct DigestDTO: Decodable {
    var spoken: String
    var kind: String
    var counts: Counts

    struct Counts: Decodable {
        var approvalsPending: Int
        var sessionsWorking: Int
        var sessionsOpen: Int
        var watchesFiring: Int
        var watchesFailing: Int
    }
}

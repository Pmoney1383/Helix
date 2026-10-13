import Foundation

// App-side mirrors of the gateway types in pc-gateway/src/types.ts and src/persona/types.ts.

enum Provider: String, Codable, Hashable, Sendable {
    case claude
    case codex
}

/// The two general entry points the gateway exposes through `POST /v1/routes` and `POST /v1/calls/start`.
enum FrontDoor: String, CaseIterable, Identifiable, Hashable, Sendable {
    case claude
    case codex

    var id: String { rawValue }
    var provider: Provider { self == .claude ? .claude : .codex }

    var displayName: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Astra"
        }
    }

    var callTitle: String { "Call \(displayName)" }

    var callSubtitle: String {
        switch self {
        case .claude: "Talk to your AI"
        case .codex: "Talk to Codex"
        }
    }

    /// Template logo in the asset catalog.
    var logo: String {
        switch self {
        case .claude: "ClaudeLogo"
        case .codex: "OpenAILogo"
        }
    }
}

enum Severity: String, Codable, Hashable, Sendable {
    case info
    case important
    case critical
}

struct GatewayStatus: Hashable {
    var isOnline: Bool
    var hostName: String
    var address: String
    var lastHeartbeat: Date
}

struct PCStatus: Hashable {
    var cpu: Double
    var gpu: Double
    var memory: Double
    var gpuName: String
}

enum LiveStatus: String, Codable, Hashable {
    case busy
    case idle
}

/// `AgentSessionInfo`: any Claude or Codex session found on the PC.
struct AgentSession: Identifiable, Hashable {
    var key: String
    var provider: Provider
    var title: String
    var projectName: String?
    var lastActivityAt: Date
    var live: Bool
    var liveStatus: LiveStatus?
    var managed: Bool

    var id: String { key }
}

struct Watcher: Identifiable, Hashable {
    var id: String
    var name: String
    var summary: String
    var severity: Severity
    var lastEventAt: Date
}

enum ApprovalStatus: String, Codable, Hashable {
    case pending
    case approved
    case rejected
    case expired
    case cancelled
}

struct Approval: Identifiable, Hashable {
    var id: String
    var sessionTitle: String?
    var tool: String
    var summary: String
    var reasons: [String]
    var status: ApprovalStatus
    var createdAt: Date
    var expiresAt: Date
    var resolvedAt: Date?
}

enum CallDirection: String, Codable, Hashable {
    case incoming
    case outgoing
}

enum CallStatus: String, Codable, Hashable {
    case ringing
    case answered
    case ended
    case missed
    case declined
    case failed
}

struct Call: Identifiable, Hashable {
    var id: String
    var direction: CallDirection
    var status: CallStatus
    var severity: Severity
    var title: String
    var summary: String
    var provider: Provider
    var createdAt: Date
    var duration: TimeInterval?
}

enum MessageSender: String, Codable, Hashable {
    case user
    case agent
    case system
}

struct ChatMessage: Identifiable, Hashable {
    var id: String
    var sender: MessageSender
    var text: String
    var createdAt: Date

    /// Watcher wake-ups arrive as user-side messages starting with "[Helix watcher".
    var isWatcherEvent: Bool { text.hasPrefix("[Helix watcher") }
}

struct Conversation: Identifiable, Hashable {
    var id: String
    var title: String
    /// Shown under the title, for example "Training run" or "Chat session".
    var typeLabel: String
    var icon: TileIcon
    var provider: Provider
    var frontDoor: FrontDoor?
    var lastActivityAt: Date
    var messages: [ChatMessage]

    var preview: String {
        messages.last.map { $0.isWatcherEvent ? "Watcher update" : $0.text } ?? ""
    }
}

struct HeroUpdate: Hashable {
    var eyebrow: String
    var title: String
    var detail: String
    var etaLabel: String
    var estimatedCompletion: Date?
    var conversationID: String?
}

enum PresenceMode: String, CaseIterable, Identifiable, Hashable {
    case auto
    case away
    case home

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: "Auto"
        case .away: "Away"
        case .home: "At PC"
        }
    }

    var explanation: String {
        switch self {
        case .auto: "Helix alerts your phone when you've been away from the PC for a while."
        case .away: "Every alert comes to your phone."
        case .home: "Alerts stay on the PC while you're sitting at it."
        }
    }
}

enum PersonaMode: String, CaseIterable, Identifiable, Hashable {
    case professional
    case casual
    case playful
    case flirty
    case unhinged

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    /// Slider values that go with each mode until the user moves them (MODE_PRESETS on the gateway).
    var preset: (teasing: Double, flirtiness: Double, sarcasm: Double, verbosity: Double) {
        switch self {
        case .professional: (0, 0, 0, 0.2)
        case .casual: (0.2, 0, 0.1, 0.35)
        case .playful: (0.6, 0.1, 0.5, 0.4)
        case .flirty: (0.6, 0.85, 0.2, 0.4)
        case .unhinged: (0.8, 0.5, 0.7, 0.5)
        }
    }
}

struct PersonaSettings: Hashable {
    var enabled: Bool
    var mode: PersonaMode
    var teasing: Double
    var flirtiness: Double
    var sarcasm: Double
    var verbosity: Double
    var speechRate: Double
    var usePCVoice: Bool
    var petNames: [String]

    mutating func apply(_ mode: PersonaMode) {
        self.mode = mode
        (teasing, flirtiness, sarcasm, verbosity) = mode.preset
    }
}

struct TranscriptLine: Identifiable, Hashable {
    var id = UUID()
    var speaker: MessageSender
    var text: String
}

enum CallPhase: Hashable {
    case connecting
    case listening
    case speaking
}

struct ActiveCall: Identifiable, Hashable {
    var id = UUID()
    var title: String
    var provider: Provider
    var startedAt: Date
    var phase: CallPhase
    var transcript: [TranscriptLine]
}

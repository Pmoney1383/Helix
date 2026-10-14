package app.helix.model

import app.helix.ui.theme.Symbol
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// App-side mirrors of the gateway types (pc-gateway/src/types.ts and src/persona/types.ts), as on the iPhone
// (ios/Helix/Services/Gateway/GatewayModels.swift).

@Serializable
enum class Provider { @SerialName("claude") Claude, @SerialName("codex") Codex;
    val wire: String get() = if (this == Claude) "claude" else "codex"
}

/** The two general entry points the gateway exposes through `POST /v1/routes` and `POST /v1/calls/start`. */
enum class FrontDoor {
    Claude, Codex;

    val provider: Provider get() = if (this == Claude) Provider.Claude else Provider.Codex
    val displayName: String get() = if (this == Claude) "Claude" else "Astra"
    val callTitle: String get() = "Call $displayName"
    val callSubtitle: String get() = if (this == Claude) "Talk to your AI" else "Talk to Codex"
    val logo: Logo get() = if (this == Claude) Logo.Claude else Logo.OpenAI
}

enum class Logo { Claude, OpenAI }

@Serializable
enum class Severity { @SerialName("info") Info, @SerialName("important") Important, @SerialName("critical") Critical }

data class GatewayStatus(val isOnline: Boolean, val hostName: String, val address: String, val lastHeartbeat: Instant)

data class PCStatus(val cpu: Double, val gpu: Double, val memory: Double, val gpuName: String)

@Serializable
enum class LiveStatus { @SerialName("busy") Busy, @SerialName("idle") Idle }

/** `AgentSessionInfo`: any Claude or Codex session found on the PC. */
data class AgentSession(
    val key: String,
    val provider: Provider,
    val title: String,
    val projectName: String?,
    val lastActivityAt: Instant,
    val live: Boolean,
    val liveStatus: LiveStatus?,
    val managed: Boolean,
) { val id: String get() = key }

data class Watcher(val id: String, val name: String, val summary: String, val severity: Severity, val lastEventAt: Instant)

@Serializable
enum class ApprovalStatus {
    @SerialName("pending") Pending, @SerialName("approved") Approved, @SerialName("rejected") Rejected,
    @SerialName("expired") Expired, @SerialName("cancelled") Cancelled;
    val label: String get() = name
}

data class Approval(
    val id: String,
    val sessionTitle: String?,
    val tool: String,
    val summary: String,
    val reasons: List<String>,
    val status: ApprovalStatus,
    val createdAt: Instant,
    val expiresAt: Instant,
    val resolvedAt: Instant? = null,
    /** When set, this approval can also trust its requester with `trustTargetTitle` for up to this many minutes. */
    val trustMaxMinutes: Int? = null,
    val trustTargetTitle: String? = null,
)

@Serializable
enum class CallDirection { @SerialName("incoming") Incoming, @SerialName("outgoing") Outgoing }

@Serializable
enum class CallStatus {
    @SerialName("ringing") Ringing, @SerialName("answered") Answered, @SerialName("ended") Ended,
    @SerialName("missed") Missed, @SerialName("declined") Declined, @SerialName("failed") Failed
}

data class Call(
    val id: String,
    val direction: CallDirection,
    val status: CallStatus,
    val severity: Severity,
    val title: String,
    val summary: String,
    val provider: Provider,
    val createdAt: Instant,
    /** Seconds. */
    val duration: Double? = null,
)

@Serializable
enum class MessageSender { @SerialName("user") User, @SerialName("agent") Agent, @SerialName("system") System }

data class ChatMessage(val id: String, val sender: MessageSender, val text: String, val createdAt: Instant) {
    /** Watcher wake-ups arrive as user-side messages starting with "[Helix watcher". */
    val isWatcherEvent: Boolean get() = text.startsWith("[Helix watcher")
}

sealed interface TileIcon {
    data class Monogram(val text: String) : TileIcon
    data class Sym(val symbol: Symbol) : TileIcon
    /** A provider mark, drawn with `BrandLogo`. */
    data class Brand(val logo: Logo) : TileIcon
}

data class Conversation(
    val id: String,
    val title: String,
    /** Shown under the title, for example "Training run" or "Chat session". */
    val typeLabel: String,
    val icon: TileIcon,
    val provider: Provider,
    val frontDoor: FrontDoor? = null,
    val lastActivityAt: Instant,
    val messages: List<ChatMessage>,
) {
    val preview: String get() = messages.lastOrNull()?.let { if (it.isWatcherEvent) "Watcher update" else it.text } ?: ""
}

data class HeroUpdate(
    val eyebrow: String,
    val title: String,
    val detail: String,
    val etaLabel: String,
    val estimatedCompletion: Instant?,
    val conversationID: String?,
)

enum class PresenceMode(val wire: String) {
    Auto("auto"), Away("away"), Home("home");

    val label: String get() = when (this) { Auto -> "Auto"; Away -> "Away"; Home -> "At PC" }
    val explanation: String get() = when (this) {
        Auto -> "Helix alerts your phone when you've been away from the PC for a while."
        Away -> "Every alert comes to your phone."
        Home -> "Alerts stay on the PC while you're sitting at it."
    }

    companion object { fun fromWire(raw: String) = entries.firstOrNull { it.wire == raw } }
}

enum class PersonaMode(val wire: String) {
    Professional("professional"), Casual("casual"), Playful("playful"), Flirty("flirty"), Unhinged("unhinged");

    val label: String get() = name

    /** Slider values that go with each mode until the user moves them (MODE_PRESETS on the gateway). */
    val preset: List<Double> get() = when (this) {
        Professional -> listOf(0.0, 0.0, 0.0, 0.2)
        Casual -> listOf(0.2, 0.0, 0.1, 0.35)
        Playful -> listOf(0.6, 0.1, 0.5, 0.4)
        Flirty -> listOf(0.6, 0.85, 0.2, 0.4)
        Unhinged -> listOf(0.8, 0.5, 0.7, 0.5)
    }
}

data class PersonaSettings(
    val enabled: Boolean,
    val mode: PersonaMode,
    val teasing: Double,
    val flirtiness: Double,
    val sarcasm: Double,
    val verbosity: Double,
    val speechRate: Double,
    val usePCVoice: Boolean,
    val petNames: List<String>,
) {
    fun applying(mode: PersonaMode): PersonaSettings {
        val (t, f, s, v) = mode.preset
        return copy(mode = mode, teasing = t, flirtiness = f, sarcasm = s, verbosity = v)
    }
}

data class TranscriptLine(val speaker: MessageSender, val text: String, val id: String = UUID.randomUUID().toString())

enum class CallPhase { Connecting, Listening, Speaking }

data class ActiveCall(
    val title: String,
    val provider: Provider,
    val startedAt: Instant,
    val phase: CallPhase,
    val transcript: List<TranscriptLine>,
    val id: String = UUID.randomUUID().toString(),
)

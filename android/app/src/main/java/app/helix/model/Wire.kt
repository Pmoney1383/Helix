package app.helix.model

import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json

// Mirrors of the gateway's real wire shapes (pc-gateway/src/types.ts, router/router.ts, discovery/indexer.ts), kept separate
// from the UI types on purpose, as on the iPhone (GatewayWireModels.swift): HelixStore maps these into the UI types.

/** Gateway timestamps are `Date().toISOString()`: ISO 8601 with milliseconds. */
object InstantSerializer : KSerializer<Instant> {
    override val descriptor = PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
}

typealias WireInstant = @Serializable(with = InstantSerializer::class) Instant

val GatewayJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** `AgentSessionInfo` (discovery/indexer.ts): any Claude or Codex session on the PC. */
@Serializable
data class AgentSessionInfoDTO(
    val key: String,
    val provider: Provider,
    val id: String,
    val title: String,
    val projectPath: String? = null,
    val projectName: String? = null,
    val createdAt: WireInstant? = null,
    val lastActivityAt: WireInstant? = null,
    val messageCount: Int = 0,
    val preview: String? = null,
    val live: Boolean = false,
    val liveStatus: LiveStatus? = null,
    val managed: Boolean = false,
    val helixSessionId: String? = null,
)

/** `Route` (router/router.ts): one phone conversation, General Claude or Astra, and whichever session is answering it. */
@Serializable
data class RouteDTO(
    val id: String,
    val title: String,
    val frontDoor: Provider,
    val routerSessionId: String,
    val targetSessionId: String? = null,
    val currentSessionId: String,
    /** Every session this conversation has touched, in order: what a message's `conversationId` is checked against. */
    val visited: List<String>,
    val createdAt: WireInstant,
    val updatedAt: WireInstant,
)

/** `AgentMessage` (types.ts). `conversationId` is the underlying session id, not a route id. */
@Serializable
data class AgentMessageDTO(
    val seq: Int,
    val id: String,
    val conversationId: String,
    val sessionId: String? = null,
    val provider: Provider? = null,
    val sender: MessageSender,
    val type: String,
    val severity: Severity,
    val text: String,
    val createdAt: WireInstant,
)

@Serializable
data class ManagedSessionDTO(val id: String, val provider: Provider, val providerSessionId: String, val title: String, val status: String)

@Serializable
data class AdoptedSessionDTO(val session: ManagedSessionDTO, val mode: String, val note: String? = null)

@Serializable
data class TranscriptPageDTO(val messages: List<Message>, val total: Int, val hasMore: Boolean) {
    @Serializable
    data class Message(val index: Int, val role: String, val text: String, val ts: WireInstant? = null, val tool: String? = null)
}

/** `Approval` (types.ts). `sessionTitle` is not on the wire; HelixStore resolves it from the synced sessions. */
@Serializable
data class ApprovalDTO(
    val id: String,
    val sessionId: String? = null,
    val source: String,
    val tool: String,
    val summary: String,
    val reasons: List<String> = emptyList(),
    val status: ApprovalStatus,
    val createdAt: WireInstant,
    val expiresAt: WireInstant,
    val resolvedAt: WireInstant? = null,
    val resolvedBy: String? = null,
    val note: String? = null,
)

/** `PresenceStatus` (notifications/presence.ts). */
@Serializable
data class PresenceStatusDTO(
    val mode: String,
    val away: Boolean,
    val reason: String,
    val idleSec: Int? = null,
    val reporterActive: Boolean,
    val awayAfterMin: Int,
)

/** `Call` (types.ts; built by calls/call-manager.ts). */
@Serializable
data class CallDTO(
    val id: String,
    val direction: CallDirection,
    val status: CallStatus,
    val severity: Severity,
    val title: String,
    val summary: String,
    /** What to say first once connected. Empty, not null, when there is nothing to say. */
    val script: String = "",
    val expects: String = "conversation",
    val sessionId: String? = null,
    val approvalId: String? = null,
    /** Set once answered (outgoing calls: immediately): the conversation to speak into. */
    val routeId: String? = null,
    /** Outgoing calls only: how long to play the ringback (1000...3000) before speaking the greeting. */
    val ringbackMs: Int? = null,
    /** Outgoing calls: the greeting pre-recorded in the PC voice. */
    val scriptClip: ClipDTO? = null,
    val deviceId: String? = null,
    val createdAt: WireInstant,
    val answeredAt: WireInstant? = null,
    val endedAt: WireInstant? = null,
)

/** A pre-recorded line in the PC voice; `url` is a gateway path serving a wav. */
@Serializable
data class ClipDTO(val id: String, val seconds: Double, val url: String)

@Serializable
data class VoiceHintsDTO(val strings: List<String>)

/** `GET /v1/digest`: an instant, model-free spoken status, already worded in the user's persona. */
@Serializable
data class DigestDTO(val spoken: String, val kind: String)

/** `device.notification`: what the gateway would have sent as an Apple push. */
@Serializable
data class DeviceNotificationDTO(
    val title: String,
    val body: String,
    val severity: Severity,
    val kind: String = "event",
    val sessionId: String? = null,
    val approvalId: String? = null,
    val eventId: String? = null,
)

/** `GET /v1/pc/status` -> `{ pc, gpu }`. */
@Serializable
data class PCStatusResponse(val pc: PC, val gpu: GPU? = null) {
    @Serializable
    data class PC(val hostname: String, val uptimeHours: Double, val cpu: CPU, val memory: Memory, val disks: List<Disk> = emptyList())

    @Serializable
    data class CPU(val model: String? = null, val cores: Int, val usagePercent: Int? = null)

    @Serializable
    data class Memory(val totalGB: Double, val freeGB: Double) {
        val usedFraction: Double get() = if (totalGB > 0) (1 - freeGB / totalGB).coerceIn(0.0, 1.0) else 0.0
    }

    @Serializable
    data class Disk(val drive: String, val totalGB: Double, val freeGB: Double)

    @Serializable
    data class GPU(val available: Boolean, val error: String? = null, val gpus: List<Card>? = null)

    @Serializable
    data class Card(
        val index: Int,
        val name: String,
        val utilizationPercent: Double,
        val memoryUsedMB: Double,
        val memoryTotalMB: Double,
        val temperatureC: Double,
        val powerW: Double,
    )
}

/** One entry of `GET /v1/watches`, only the fields the Status screen shows. */
@Serializable
data class WatchDTO(
    val id: String,
    val name: String,
    val severity: Severity,
    val enabled: Boolean,
    val createdAt: WireInstant,
    val lastCheckedAt: WireInstant? = null,
    val lastEventAt: WireInstant? = null,
    val lastStatus: String? = null,
    val lastError: String? = null,
) {
    val asWatcher: Watcher get() {
        val summary = when (lastStatus) {
            "triggered" -> "Needs attention"
            "error" -> lastError?.let { "Check failed: $it" } ?: "Check failed"
            "ok" -> "OK"
            else -> if (enabled) "Waiting for the first check" else "Paused"
        }
        val quiet = lastStatus == "ok" || lastStatus == null || !enabled
        return Watcher(id, name, if (enabled) summary else "Paused", if (quiet) Severity.Info else severity, lastEventAt ?: lastCheckedAt ?: createdAt)
    }
}

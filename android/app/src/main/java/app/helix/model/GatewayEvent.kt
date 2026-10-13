package app.helix.model

import android.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The server's `GatewayEvent` union (pc-gateway/src/types.ts). Only the cases the app acts on carry a payload; anything
 * else becomes `Unknown`, so a new event type never breaks the socket.
 */
sealed interface GatewayEvent {
    data class Hello(val deviceId: String?) : GatewayEvent
    data class MessageCreated(val message: AgentMessageDTO) : GatewayEvent
    data class AgentOutputDelta(val sessionId: String, val turnId: String, val text: String) : GatewayEvent
    data class AgentOutputFinal(val sessionId: String, val turnId: String, val text: String, val messageId: String, val spoken: String?) : GatewayEvent
    /** One complete, speech-ready sentence of a reply (voice turns only); speak them in order as they arrive. */
    data class AgentSpeech(val sessionId: String, val turnId: String, val seq: Int, val text: String, val engine: String?) : GatewayEvent
    /** PC voice: one piece of raw mono PCM (`pcm_s16le`), played in arrival order. */
    data class AgentAudio(val sessionId: String, val turnId: String, val seq: Int, val sampleRate: Int, val pcm: ByteArray) : GatewayEvent
    data class AgentAudioEnd(val sessionId: String, val turnId: String) : GatewayEvent
    /** The PC voice could not speak this turn: say the `AgentSpeech` text with the phone's voice. */
    data class AgentAudioUnavailable(val sessionId: String, val turnId: String) : GatewayEvent
    /** A spoken turn has produced all its sentences. `cancelled`: it was interrupted, drop anything still queued. */
    data class AgentSpeechEnd(val sessionId: String, val turnId: String, val cancelled: Boolean) : GatewayEvent
    data class AgentSessionChanged(val session: AgentSessionInfoDTO) : GatewayEvent
    data class CallRinging(val call: CallDTO) : GatewayEvent
    data class CallAnswered(val call: CallDTO) : GatewayEvent
    data class CallEnded(val call: CallDTO) : GatewayEvent
    /** The user said goodbye (or the agent ended the call): speak the next reply, then hang up. */
    data class CallHangup(val call: CallDTO) : GatewayEvent
    data class ApprovalRequested(val approval: ApprovalDTO) : GatewayEvent
    data class ApprovalResolved(val approval: ApprovalDTO) : GatewayEvent
    data class RouteHandoff(val routeId: String, val fromSessionId: String, val toSessionId: String, val toTitle: String, val mode: String) : GatewayEvent
    /** What an iPhone would get as an Apple push: shown as a notification on Android. */
    data class DeviceNotification(val notification: DeviceNotificationDTO) : GatewayEvent
    data object Pong : GatewayEvent
    data class Unknown(val type: String) : GatewayEvent

    companion object {
        /** Null when the text is not a gateway event at all. A known type with a bad payload is `Unknown` too. */
        fun decode(text: String): GatewayEvent? {
            val obj = runCatching { GatewayJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
            val type = obj.str("type") ?: return null
            return runCatching { decode(type, obj) }.getOrElse { Unknown(type) }
        }

        private fun decode(type: String, o: JsonObject): GatewayEvent = when (type) {
            "hello" -> Hello(o.str("deviceId"))
            "message.created" -> MessageCreated(o.obj("message"))
            "agent.output.delta" -> AgentOutputDelta(o.req("sessionId"), o.req("turnId"), o.req("text"))
            "agent.output.final" -> AgentOutputFinal(o.req("sessionId"), o.req("turnId"), o.req("text"), o.req("messageId"), o.str("spoken"))
            "agent.speech" -> AgentSpeech(o.req("sessionId"), o.req("turnId"), o.int("seq"), o.req("text"), o.str("engine"))
            "agent.audio" -> AgentAudio(
                o.req("sessionId"), o.req("turnId"), o.int("seq"), o.int("sampleRate"),
                runCatching { Base64.decode(o.req("data"), Base64.DEFAULT) }.getOrDefault(ByteArray(0)),
            )
            "agent.audio.end" -> AgentAudioEnd(o.req("sessionId"), o.req("turnId"))
            "agent.audio.unavailable" -> AgentAudioUnavailable(o.req("sessionId"), o.req("turnId"))
            "agent.speech.end" -> AgentSpeechEnd(o.req("sessionId"), o.req("turnId"), o["cancelled"]?.jsonPrimitive?.booleanOrNull ?: false)
            "agent.session.changed" -> AgentSessionChanged(o.obj("session"))
            "call.ringing" -> CallRinging(o.obj("call"))
            "call.answered" -> CallAnswered(o.obj("call"))
            "call.ended" -> CallEnded(o.obj("call"))
            "call.hangup" -> CallHangup(o.obj("call"))
            "approval.requested" -> ApprovalRequested(o.obj("approval"))
            "approval.resolved" -> ApprovalResolved(o.obj("approval"))
            "route.handoff" -> RouteHandoff(o.req("routeId"), o.req("fromSessionId"), o.req("toSessionId"), o.req("toTitle"), o.req("mode"))
            "device.notification" -> DeviceNotification(o.obj("notification"))
            "pong" -> Pong
            else -> Unknown(type)
        }

        private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
        private fun JsonObject.req(key: String): String = str(key) ?: error("missing $key")
        private fun JsonObject.int(key: String): Int = this[key]?.jsonPrimitive?.intOrNull ?: error("missing $key")
        private inline fun <reified T> JsonObject.obj(key: String): T = GatewayJson.decodeFromJsonElement(this[key] ?: error("missing $key"))
    }
}

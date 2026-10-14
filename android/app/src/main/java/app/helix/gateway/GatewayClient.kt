package app.helix.gateway

import android.util.Log
import app.helix.model.AdoptedSessionDTO
import app.helix.model.AgentMessageDTO
import app.helix.model.AgentSessionInfoDTO
import app.helix.model.ApprovalDTO
import app.helix.model.ApprovalStatus
import app.helix.model.CallDTO
import app.helix.model.DigestDTO
import app.helix.model.GatewayJson
import app.helix.model.PCStatusResponse
import app.helix.model.PresenceMode
import app.helix.model.PresenceStatusDTO
import app.helix.model.Provider
import app.helix.model.RouteDTO
import app.helix.model.TranscriptPageDTO
import app.helix.model.VoiceHintsDTO
import app.helix.model.WatchDTO
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Talks to the PC gateway over HTTPS (the iPhone's GatewayClient.swift). Stateless beyond the [GatewaySession] it holds:
 * every call reads the current address and token, so pairing or an address change takes effect on the next request.
 */
class GatewayClient(private val session: GatewaySession, val http: OkHttpClient = sharedHttp) {

    sealed class ClientError(message: String) : Exception(message) {
        class InvalidUrl : ClientError("The gateway sent back something unexpected.")
        class InvalidResponse : ClientError("The gateway sent back something unexpected.")
        class NotPaired : ClientError("This device isn't paired yet.")
        class Http(val status: Int, val serverMessage: String?) : ClientError(
            when (status) {
                401 -> "The pairing was rejected or has expired. Pair again."
                429 -> "Too many attempts. Wait a few minutes and try again."
                else -> serverMessage ?: "The gateway returned an error ($status)."
            },
        )
        class Decoding(cause: Throwable) : ClientError("The gateway sent back something unexpected.") { init { initCause(cause) } }
        class Transport(cause: Throwable) : ClientError(describe(cause)) { init { initCause(cause) } }
        /** 409 `heavy_session`: the session is big and its cache is cold; the caller decides. */
        class HeavySession(val contextTokens: Int, val reason: String) :
            ClientError("This session is about ${contextTokens / 1000}k tokens - continuing will use a lot of your usage.")

        companion object {
            fun describe(e: Throwable): String = when (e) {
                is UnknownHostException, is ConnectException, is SocketTimeoutException ->
                    "Can't reach the PC. Check it's on and that this phone is on the same Tailscale network."
                else -> e.message ?: "Network error."
            }
        }
    }

    // MARK: Health (no auth)

    @Serializable data class HealthResponse(val ok: Boolean, val name: String, val uptimeSec: Int)

    suspend fun checkHealth(): HealthResponse = send("GET", "/health", auth = false)
    suspend fun pcStatus(): PCStatusResponse = send("GET", "/v1/pc/status")
    suspend fun watches(): List<WatchDTO> = send<WatchList>("GET", "/v1/watches").watches

    @Serializable private data class WatchList(val watches: List<WatchDTO>)

    // MARK: Pairing (no auth: the code is the credential, single use, 5 min)

    @Serializable data class PairResult(val deviceId: String, val token: String)

    @Serializable private data class PairBody(val code: String, val deviceName: String, val platform: String, val publicKey: String?, val keyProof: String?)

    /** A new pairing brings a fresh signing key; if pairing fails the old key is put back so an existing pairing keeps working. */
    suspend fun pair(code: String, deviceName: String): PairResult {
        val signer = session.signer
        val previous = signer.beginReplacement()
        val body = PairBody(code.trim(), deviceName, "android", signer.publicKeyBase64, signer.enrollmentProof())
        return try {
            send<PairResult>("POST", "/v1/pair/complete", body = GatewayJson.encodeToString(PairBody.serializer(), body), auth = false)
                .also { signer.commit(previous) }
        } catch (e: Exception) {
            signer.restore(previous)
            throw e
        }
    }

    // MARK: Request signing

    @Serializable data class SigningStatus(val enrolled: Boolean, val required: Boolean)

    suspend fun signingStatus(): SigningStatus = send("GET", "/v1/devices/me/key")

    /** Enrolls this phone's public key (an already-paired phone). Sent with the bearer token only: nothing to verify against yet. */
    suspend fun enrollSigningKey() {
        val signer = session.signer
        if (!signer.ensureKey()) return
        val publicKey = signer.publicKeyBase64 ?: return
        val proof = signer.enrollmentProof() ?: return
        val body = buildJsonObject { put("publicKey", publicKey); put("keyProof", proof) }.toString()
        send<JsonObject>("PUT", "/v1/devices/me/key", body = body, sign = false)
    }

    // MARK: Presence

    suspend fun getPresence(): PresenceStatusDTO = send("GET", "/v1/presence")
    suspend fun changePresence(mode: PresenceMode): PresenceStatusDTO =
        send("PUT", "/v1/presence", body = buildJsonObject { put("mode", mode.wire) }.toString())

    // MARK: Agent sessions

    @Serializable private data class Sessions(val sessions: List<AgentSessionInfoDTO>)

    suspend fun listAgentSessions(limit: Int = 100): List<AgentSessionInfoDTO> =
        send<Sessions>("GET", "/v1/agent-sessions", query = listOf("limit" to "$limit")).sessions

    suspend fun sessionTranscript(provider: Provider, id: String, before: Int? = null): TranscriptPageDTO =
        send("GET", "/v1/agent-sessions/${provider.wire}/$id/transcript", query = listOfNotNull("limit" to "100", before?.let { "before" to "$it" }))

    suspend fun adoptSession(provider: Provider, id: String): AdoptedSessionDTO =
        send("POST", "/v1/agent-sessions/${provider.wire}/$id/adopt", body = buildJsonObject { put("mode", "auto") }.toString())

    @Serializable data class SendAccepted(val sessionId: String? = null, val messageId: String, val turnId: String)

    suspend fun sendSessionMessage(sessionId: String, text: String, confirmHeavy: Boolean = false): SendAccepted =
        send("POST", "/v1/sessions/$sessionId/message", body = buildJsonObject {
            put("text", text); if (confirmHeavy) put("confirmHeavy", true)
        }.toString())

    @Serializable private data class Messages(val messages: List<AgentMessageDTO>)

    suspend fun sessionMessages(sessionId: String): List<AgentMessageDTO> {
        val all = mutableListOf<AgentMessageDTO>()
        var after = 0
        while (true) {
            val page = send<Messages>("GET", "/v1/conversations/$sessionId/messages", query = listOf("limit" to "500", "after" to "$after")).messages
            all += page
            if (page.size != 500) return all
            val next = page.last().seq
            if (next <= after) throw ClientError.InvalidResponse()
            after = next
        }
    }

    // MARK: Approvals

    @Serializable private data class Approvals(val approvals: List<ApprovalDTO>)

    suspend fun listApprovals(status: ApprovalStatus? = null, limit: Int = 100): List<ApprovalDTO> =
        send<Approvals>("GET", "/v1/approvals", query = listOfNotNull("limit" to "$limit", status?.let { "status" to it.name.lowercase() })).approvals

    /** Settles once: resolving an already-resolved approval just returns its current state. */
    /** `trustForMin` (approve only): also trust the requester for that long, where the approval offers it. */
    suspend fun resolveApproval(id: String, approve: Boolean, trustForMin: Int? = null): ApprovalDTO =
        send("POST", "/v1/approvals/$id/${if (approve) "approve" else "reject"}",
            body = if (approve && trustForMin != null) "{\"trustForMin\":$trustForMin}" else "{}")

    // MARK: Routes - the General Claude / Astra front doors

    @Serializable private data class Routes(val routes: List<RouteDTO>)

    suspend fun listRoutes(): List<RouteDTO> = send<Routes>("GET", "/v1/routes").routes
    suspend fun getRoute(id: String): RouteDTO = send("GET", "/v1/routes/$id")
    suspend fun createRoute(provider: Provider): RouteDTO =
        send("POST", "/v1/routes", body = buildJsonObject { put("provider", provider.wire) }.toString())

    suspend fun sendRouteMessage(routeId: String, text: String, voice: Boolean? = null, confirmHeavy: Boolean = false): SendAccepted =
        send("POST", "/v1/routes/$routeId/message", body = buildJsonObject {
            put("text", text)
            voice?.let { put("voice", it) }
            if (confirmHeavy) put("confirmHeavy", true)
        }.toString())

    /** The route's merged history: every session it has been handed to, in order. */
    suspend fun routeMessages(routeId: String, limit: Int = 200): List<AgentMessageDTO> {
        val all = mutableListOf<AgentMessageDTO>()
        var cursor = 0
        while (true) {
            val page = send<Messages>("GET", "/v1/routes/$routeId/messages", query = listOf("after" to "$cursor", "limit" to "$limit")).messages
            all += page
            if (page.size != limit) return all
            val next = page.last().seq
            if (next <= cursor) throw ClientError.InvalidResponse()
            cursor = next
        }
    }

    suspend fun resetRoute(routeId: String): RouteDTO = send("POST", "/v1/routes/$routeId/reset", body = "{}")

    // MARK: Calls (docs/CALLS.md)

    /** "Call Claude", "Call Astra" (provider codex). Already answered when this returns, with `script` as the greeting. */
    suspend fun startCall(provider: Provider): CallDTO =
        send("POST", "/v1/calls/start", body = buildJsonObject { put("provider", provider.wire) }.toString())

    suspend fun endCall(id: String): CallDTO = send("POST", "/v1/calls/$id/end", body = "{}")

    /** 409: the call is no longer ringing (declined elsewhere, missed, or the approval was already resolved). */
    suspend fun answerCall(id: String): CallDTO = send("POST", "/v1/calls/$id/answer", body = "{}")
    suspend fun declineCall(id: String): CallDTO = send("POST", "/v1/calls/$id/decline", body = "{}")

    @Serializable data class CallDecision(val call: CallDTO, val approvalStatus: String? = null)

    /** Accepted once, on an answered approval call. */
    suspend fun decideCall(id: String, approve: Boolean): CallDecision =
        send("POST", "/v1/calls/$id/decision", body = buildJsonObject { put("approve", approve) }.toString())

    /** Starts loading the PC voice so it is ready when a call starts. Harmless and instant. */
    suspend fun warmVoice() { runCatching { send<JsonObject>("POST", "/v1/voice/tts/warm", body = "{}") } }

    suspend fun voiceHints(): List<String> = send<VoiceHintsDTO>("GET", "/v1/voice/hints").strings
    suspend fun digest(): DigestDTO = send("GET", "/v1/digest")

    /** Raw bytes of a clip path from the gateway (`/v1/voice/clips/:id`). */
    suspend fun clipData(path: String): ByteArray = rawGet(path).first

    /** What Helix says when it calls you, in the PC voice; null = speak `script` with the phone's voice. Polls while recording (202). */
    suspend fun callScriptAudio(id: String): ByteArray? {
        repeat(9) {
            val (data, status) = runCatching { rawGet("/v1/calls/$id/script-audio") }.getOrNull() ?: return null
            when (status) {
                200 -> return data
                202 -> delay(500)
                else -> return null
            }
        }
        return null
    }

    // MARK: Generic request

    private suspend fun rawGet(path: String): Pair<ByteArray, Int> = withContext(Dispatchers.IO) {
        val request = build("GET", path, emptyList(), null, auth = true, sign = true)
        try {
            http.newCall(request).execute().use { (it.body?.bytes() ?: ByteArray(0)) to it.code }
        } catch (e: IOException) {
            throw ClientError.Transport(e)
        }
    }

    private suspend inline fun <reified T> send(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        auth: Boolean = true,
        sign: Boolean = true,
    ): T = withContext(Dispatchers.IO) {
        val request = build(method, path, query, body, auth, sign)
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            Log.w(TAG, "transport error for $method ${request.url}: $e")
            throw ClientError.Transport(e)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                Log.w(TAG, "${it.code} for $method ${request.url} - body: $text")
                val error = runCatching { GatewayJson.decodeFromString(ErrorBody.serializer(), text) }.getOrNull()
                if (it.code == 409 && error?.code == "heavy_session" && error.contextTokens != null) {
                    throw ClientError.HeavySession(error.contextTokens, error.reason ?: "cold")
                }
                throw ClientError.Http(it.code, error?.error)
            }
            try {
                GatewayJson.decodeFromString(serializer<T>(), text.ifEmpty { "{}" })
            } catch (e: Exception) {
                throw ClientError.Decoding(e)
            }
        }
    }

    @Serializable private data class ErrorBody(val error: String = "", val code: String? = null, val contextTokens: Int? = null, val reason: String? = null)

    private fun build(method: String, path: String, query: List<Pair<String, String>>, body: String?, auth: Boolean, sign: Boolean): Request {
        val base = session.baseUrl.toHttpUrlOrNull() ?: throw ClientError.InvalidUrl()
        val url: HttpUrl = base.newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val bytes = body?.toByteArray(Charsets.UTF_8)
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        builder.method(method, bytes?.toRequestBody(JSON))
        if (auth) {
            val token = session.deviceToken ?: throw ClientError.NotPaired()
            builder.header("Authorization", "Bearer $token")
            if (sign) {
                val target = url.encodedPath + (url.encodedQuery?.let { "?$it" } ?: "")
                session.signer.headers(method, target, bytes ?: ByteArray(0), session.deviceId).forEach { (k, v) -> builder.header(k, v) }
            }
        }
        return builder.build()
    }

    companion object {
        private const val TAG = "GatewayClient"
        private val JSON = "application/json".toMediaType()
        val sharedHttp: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }
}

package app.helix.gateway

import android.os.Handler
import android.os.Looper
import app.helix.model.GatewayEvent
import kotlin.math.min
import kotlin.math.pow
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * One persistent connection to `WS /v1/ws` (the iPhone's GatewayWebSocket.swift). The gateway pushes every event to every
 * connected device, so there is nothing to subscribe to; [onEvent] fires on the main thread for each one. Reconnects with
 * backoff on any drop for as long as [connect] was called more recently than [disconnect].
 */
class GatewayWebSocket(private val session: GatewaySession, private val client: GatewayClient) {
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private var reconnectPending: Runnable? = null

    var isConnected = false
        private set
    var onEvent: ((GatewayEvent) -> Unit)? = null
    var onConnectionChange: ((Boolean) -> Unit)? = null

    fun connect() {
        if (session.deviceToken == null || socket != null || reconnectPending != null) return
        shouldReconnect = true
        open()
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectPending?.let(main::removeCallbacks)
        reconnectPending = null
        socket?.close(1001, null)
        socket = null
        setConnected(false)
    }

    /** Reconnects now if a reconnect is waiting (the network came back, the app came to the foreground). */
    fun nudge() {
        if (!shouldReconnect || socket != null) return
        reconnectPending?.let(main::removeCallbacks)
        reconnectPending = null
        reconnectAttempt = 0
        open()
    }

    private fun open() {
        val token = session.deviceToken ?: return
        val base = session.baseUrl.toHttpUrlOrNull() ?: return
        val url = base.newBuilder().encodedPath("/v1/ws").build()
        val builder = Request.Builder().url(url).header("Authorization", "Bearer $token")
        // The upgrade is signed like any request: GET, path, empty body.
        session.signer.headers("GET", url.encodedPath, ByteArray(0), session.deviceId).forEach { (k, v) -> builder.header(k, v) }
        var mine: WebSocket? = null
        mine = client.http.newWebSocket(builder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = main.post {
                if (socket !== mine) return@post
                reconnectAttempt = 0
                setConnected(true)
            }.let { }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = GatewayEvent.decode(text) ?: return
                main.post { if (socket === mine) onEvent?.invoke(event) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = main.post { if (socket === mine) scheduleReconnect() }.let { }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = main.post { if (socket === mine) scheduleReconnect() }.let { }
        })
        socket = mine
    }

    private fun scheduleReconnect() {
        socket?.cancel()
        socket = null
        setConnected(false)
        if (!shouldReconnect || session.deviceToken == null) return
        reconnectAttempt++
        val delayMs = (min(30.0, 2.0.pow(reconnectAttempt)) * 1000).toLong()
        val task = Runnable {
            reconnectPending = null
            if (shouldReconnect) open()
        }
        reconnectPending = task
        main.postDelayed(task, delayMs)
    }

    private fun setConnected(connected: Boolean) {
        if (isConnected == connected) return
        isConnected = connected
        onConnectionChange?.invoke(connected)
    }

    /** The server's client messages (api/websocket.ts). */
    fun sendRoute(routeId: String, text: String, voice: Boolean? = null) = send(buildJsonObject {
        put("type", "route.send"); put("routeId", routeId); put("text", text); voice?.let { put("voice", it) }
    }.toString())

    fun ping() = send(buildJsonObject { put("type", "ping") }.toString())

    private fun send(text: String) { socket?.send(text) }
}

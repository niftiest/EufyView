package com.eufyview.tv

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * A camera on the dashboard. Immutable identity (serial/name/house) plus the
 * last detection we've seen this session, used for the hero subtitle, the
 * "recent activity" row ordering, and the activity dot on the card.
 */
data class Camera(
    val serial: String,
    val name: String,
    val house: String,
    var lastLabel: String? = null,
    var lastEventAt: Long = 0L
)

/**
 * The dashboard's own live link to the server. Opens a WebSocket to /api (same
 * feed the alert service uses, scope-correct via the device token), asks for the
 * camera catalog once, then stays connected to receive detection events so the
 * home screen updates in real time while it's on screen. Closed when the
 * dashboard isn't visible - the resident AlertService is what keeps alerts
 * flowing in the background; this is purely for the UI.
 *
 * All callbacks are delivered on the main thread.
 */
class CatalogClient(
    private val serverUrl: String,
    private val token: String,
    private val onCatalog: (List<Camera>) -> Unit,
    private val onDetection: (serial: String, name: String, label: String, timeMs: Long) -> Unit,
    private val onStatus: (String) -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var backoffMs = 2000L
    private var stopped = false

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    fun start() {
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        main.removeCallbacksAndMessages(null)
        val old = ws
        ws = null
        try { old?.close(1000, "dashboard hidden") } catch (_: Exception) {}
    }

    private fun connect() {
        if (stopped) return
        val old = ws
        ws = null
        try { old?.close(1000, "reconnect") } catch (_: Exception) {}
        val req = Request.Builder()
            .url("$serverUrl/api")
            .addHeader("Authorization", "Bearer $token")
            .build()
        post { onStatus("Connecting…") }
        ws = http.newWebSocket(req, listener)
    }

    private fun scheduleReconnect() {
        if (stopped) return
        main.removeCallbacksAndMessages(null)
        main.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(30000L)
    }

    private fun post(r: () -> Unit) = main.post(r)

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket != ws) { try { webSocket.close(1000, "superseded") } catch (_: Exception) {}; return }
            backoffMs = 2000L
            post { onStatus("Connected") }
            webSocket.send("{\"command\":\"start_listening\"}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket != ws) return
            try {
                val obj = JSONObject(text)
                when (obj.optString("type")) {
                    "result" -> if (obj.optString("messageId") == "start_listening")
                        handleCatalog(obj.optJSONObject("result"))
                    "event" -> handleEvent(obj.optJSONObject("event"))
                }
            } catch (e: Exception) {
                Log.w(TAG, "bad message: ${e.message}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket != ws) return
            post { onStatus("Disconnected") }
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket != ws) return
            post { onStatus("Reconnecting…") }
            scheduleReconnect()
        }
    }

    private fun handleCatalog(result: JSONObject?) {
        val state = result?.optJSONObject("state") ?: return
        val devices = state.optJSONArray("devices") ?: return
        val names = state.optJSONObject("deviceNames")
        val houses = state.optJSONObject("deviceHouseNames")
        val list = ArrayList<Camera>(devices.length())
        for (i in 0 until devices.length()) {
            val sn = devices.optString(i)
            if (sn.isEmpty()) continue
            val name = names?.optString(sn)?.takeIf { it.isNotBlank() } ?: sn
            val house = houses?.optString(sn)?.takeIf { it.isNotBlank() } ?: ""
            list.add(Camera(sn, name, house))
        }
        post { onCatalog(list) }
    }

    private fun handleEvent(ev: JSONObject?) {
        if (ev == null) return
        // Same gate as the alert service: only real per-device detections, not
        // station/system/property-changed noise.
        if (ev.optString("source") != "device") return
        if (!ev.optBoolean("state", true)) return
        val serial = ev.optString("serialNumber")
        if (serial.isEmpty()) return
        val name = ev.optString("name").ifEmpty { serial }
        val event = ev.optString("event")
        val label = ev.optString("label").ifEmpty { event.ifEmpty { "Detection" } }
        val time = if (ev.optLong("time", 0L) > 0) ev.optLong("time") else System.currentTimeMillis()
        post { onDetection(serial, name, label, time) }
    }

    companion object {
        private const val TAG = "EufyViewTV"
    }
}

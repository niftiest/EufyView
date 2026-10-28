package com.eufyview.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
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
 * Foreground service that holds one WebSocket to the EufyView server's /api feed
 * and raises an on-screen banner for every wanted detection. No cloud push is
 * involved - the server already broadcasts detections to connected clients, and a
 * TV is always on, so a resident socket is the simplest reliable delivery.
 */
class AlertService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var ws: WebSocket? = null
    private var backoffMs = 3000L

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)   // keep NAT / proxies from dropping us
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        try {
            // Static text, set once. We deliberately NEVER update this notification
            // on connection-state changes: Fire TV surfaces every notification update
            // as an on-screen pop-up, so churning it spams "Disconnected/Connecting"
            // toasts. Live status lives in the app (MainActivity) via `status`.
            startForeground(NOTIF_ID, buildNotification("Watching for camera alerts"))
            Log.i(TAG, "onCreate startForeground ok")
        } catch (e: Exception) {
            Log.e(TAG, "startForeground FAILED: ${e.message}", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand flags=$flags startId=$startId")
        // Any start (boot, launch, or a settings save) means "reconnect with
        // current settings".
        connect()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        main.removeCallbacksAndMessages(null)
        val old = ws
        ws = null   // so the close below (and any late event) is seen as superseded
        try { old?.close(1000, "service stop") } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun connect() {
        // Supersede any existing socket. We null `ws` BEFORE closing so the old
        // socket's onClosed/onFailure is recognised as stale (webSocket != ws) and
        // does NOT schedule a reconnect - otherwise every reconnect/onStartCommand
        // would spawn another, looping every few seconds.
        val old = ws
        ws = null
        try { old?.close(1000, "reconnect") } catch (_: Exception) {}
        if (!prefs.isConfigured) {
            status = "Not configured - open the app to set server + token"
            return
        }
        val url = prefs.serverUrl + "/api"
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer " + prefs.token)
            .build()
        status = "Connecting…"
        Log.i(TAG, "connect -> $url")
        ws = http.newWebSocket(req, listener)
    }

    private fun scheduleReconnect() {
        main.removeCallbacksAndMessages(null)   // coalesce - never stack reconnects
        main.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60000L)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket != ws) { try { webSocket.close(1000, "superseded") } catch (_: Exception) {}; return }
            backoffMs = 3000L
            status = "Connected"
            Log.i(TAG, "WS onOpen")
            // Learn the device list (serials); names also arrive on each event.
            webSocket.send("{\"command\":\"start_listening\"}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket != ws) return   // ignore a superseded socket (avoids dup alerts)
            try {
                val obj = JSONObject(text)
                when (obj.optString("type")) {
                    "event" -> handleEvent(obj.optJSONObject("event") ?: return)
                    "result" -> if (obj.optString("messageId") == "start_listening")
                        handleCatalog(obj.optJSONObject("result"))
                }
            } catch (e: Exception) {
                Log.w(TAG, "bad message: ${e.message}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (webSocket != ws) return   // a superseded socket - ignore
            Log.w(TAG, "WS onFailure ${t.message} httpCode=${response?.code}", t)
            status = "Disconnected (${response?.code ?: t.message})"
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (webSocket != ws) return   // a superseded socket (we replaced it) - ignore
            Log.i(TAG, "WS onClosed code=$code reason=$reason")
            status = "Reconnecting…"
            scheduleReconnect()
        }
    }

    private fun handleEvent(ev: JSONObject) {
        // Only real detection alerts (the server's notification funnel - the same
        // ones the phone gets pushed) carry source "device" + a non-empty id + a
        // label. Station/system/property-changed events (e.g. a flapping station's
        // "connection error") must NOT pop a toast.
        if (ev.optString("source") != "device") return
        if (!ev.optBoolean("state", true)) return
        val id = ev.optString("id")
        if (id.isEmpty()) return
        val serial = ev.optString("serialNumber")
        if (serial.isEmpty()) return
        val name = ev.optString("name").ifEmpty { serial }
        val event = ev.optString("event")
        val label = ev.optString("label").ifEmpty { event.ifEmpty { "Detection" } }
        val category = Categories.categorize(event, label)
        prefs.rememberCamera(serial, name)
        if (!prefs.passes(serial, category)) return

        // Title as "House - Camera" (e.g. "Ima - Front Door") when we know the house.
        val house = prefs.knownCameras()[serial]?.house ?: ""
        val title = if (house.isNotEmpty()) "$house - $name" else name
        val snapUrl = prefs.serverUrl + "/history/snap/" + id + ".jpg"
        val rank = specificity(event, category)
        main.post {
            OverlayManager.show(
                this, http, prefs.token,
                serverUrl = prefs.serverUrl,
                serial = serial,
                title = title,
                subtitle = label,
                snapUrl = snapUrl,
                seconds = prefs.bannerSeconds,
                rank = rank
            )
        }
    }

    // One real-world detection fans out into several server events in a burst -
    // e.g. a familiar face also fires "person detected" and "motion detected"
    // within a few hundred ms. They're genuinely distinct event types (so the
    // server keeps them separate), but on screen we want ONE banner showing the
    // most meaningful one, not whichever landed last. This ranks an event's
    // specificity so OverlayManager can keep the highest and ignore the rest of
    // the burst. Higher = more specific / more worth showing.
    private fun specificity(event: String, category: String): Int {
        val e = event.lowercase()
        return when {
            e.contains("ring") || category == "ring" -> 6   // a deliberate doorbell press
            e.contains("familiar") -> 5                      // familiar/named face = who it is
            e.contains("stranger") -> 4
            e.contains("person") || category == "person" -> 3
            category == "pet" || category == "vehicle" || category == "package" -> 3
            category == "sound" -> 2
            e.contains("motion") || category == "motion" -> 1
            else -> 3   // unknown but specific-ish: above motion, below faces
        }
    }

    // The start_listening result lists every camera in scope with its friendly
    // name and house, so the settings picker shows all cameras - not just ones
    // that have happened to fire an event.
    private fun handleCatalog(result: JSONObject?) {
        val state = result?.optJSONObject("state") ?: return
        val devices = state.optJSONArray("devices") ?: return
        val names = state.optJSONObject("deviceNames")
        val houses = state.optJSONObject("deviceHouseNames")
        for (i in 0 until devices.length()) {
            val sn = devices.optString(i)
            if (sn.isEmpty()) continue
            prefs.rememberCamera(sn, names?.optString(sn), houses?.optString(sn))
        }
        Log.i(TAG, "catalog: ${devices.length()} camera(s)")
    }

    // ---- foreground notification plumbing ----

    private fun buildNotification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL) == null) {
                mgr.createNotificationChannel(
                    NotificationChannel(CHANNEL, "EufyView alerts", NotificationManager.IMPORTANCE_MIN)
                )
            }
            return Notification.Builder(this, CHANNEL)
                .setContentTitle("EufyView TV")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setOngoing(true)
                .build()
        }
        @Suppress("DEPRECATION")
        return Notification.Builder(this)
            .setContentTitle("EufyView TV")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "EufyViewTV"
        private const val CHANNEL = "eufyview_tv"
        private const val NOTIF_ID = 1

        /** Current connection status, for MainActivity to display. */
        @Volatile var status: String = "Idle"

        fun start(ctx: Context) {
            val i = Intent(ctx, AlertService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }
}

package com.eufyview.tv

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Finds the EufyView server on the local network so the TV doesn't need the IP
 * typed in. Strategy: enumerate the device's own /24 and probe
 * http://<host>:<port>/health on each - that endpoint is auth-exempt and its
 * JSON (status:ok + an eufyConnected field) is a reliable EufyView fingerprint,
 * so no server-side discovery service (mDNS etc.) is required.
 */
object Discovery {

    const val DEFAULT_PORT = 3001

    data class Found(val ip: String, val url: String, val eufyConnected: Boolean)

    /** This device's site-local IPv4 (wifi or ethernet), or null. */
    fun localIpv4(): String? {
        try {
            for (ni in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp || ni.isLoopback) continue
                for (addr in Collections.list(ni.inetAddresses)) {
                    if (addr is Inet4Address && addr.isSiteLocalAddress) return addr.hostAddress
                }
            }
        } catch (_: Exception) {}
        return null
    }

    /**
     * Probe every host on this device's /24 for an EufyView server. Blocking -
     * call off the main thread. onProgress(done,total) fires as probes finish.
     */
    fun scan(port: Int, onProgress: (Int, Int) -> Unit): List<Found> {
        val ip = localIpv4() ?: return emptyList()
        val base = ip.substringBeforeLast('.') + "."
        val client = OkHttpClient.Builder()
            .connectTimeout(700, TimeUnit.MILLISECONDS)
            .readTimeout(700, TimeUnit.MILLISECONDS)
            .callTimeout(1200, TimeUnit.MILLISECONDS)
            .build()
        val found = Collections.synchronizedList(mutableListOf<Found>())
        val total = 254
        val done = AtomicInteger(0)
        val pool = Executors.newFixedThreadPool(48)
        val latch = CountDownLatch(total)
        for (n in 1..254) {
            val host = base + n
            pool.execute {
                try {
                    val req = Request.Builder().url("http://$host:$port/health").build()
                    client.newCall(req).execute().use { r ->
                        val body = if (r.isSuccessful) (r.body?.string() ?: "") else ""
                        if (body.contains("\"status\":\"ok\"") && body.contains("eufyConnected")) {
                            found.add(Found(host, "http://$host:$port", body.contains("\"eufyConnected\":true")))
                        }
                    }
                } catch (_: Exception) {
                } finally {
                    onProgress(done.incrementAndGet(), total)
                    latch.countDown()
                }
            }
        }
        latch.await(20, TimeUnit.SECONDS)
        pool.shutdownNow()
        // Prefer a server that's actually connected to Eufy, then lowest IP.
        return found.sortedWith(compareByDescending<Found> { it.eufyConnected }.thenBy { it.ip })
    }

    /** Strip the scheme for display, so the field shows "host:port" not "http://…". */
    fun stripScheme(url: String): String =
        url.removePrefix("https://").removePrefix("http://").trimEnd('/')

    /** Base URLs to try for a user entry. If they typed a scheme we honour it; a bare
     *  host/ip (with optional :port) is tried https-first then http - so a local box
     *  and a remote VPS both work without the user choosing a scheme. A bare host with
     *  no port gets the app default (:3001). */
    fun candidates(input: String): List<String> {
        val s = input.trim().trimEnd('/')
        if (s.isEmpty()) return emptyList()
        if (s.startsWith("http://") || s.startsWith("https://")) return listOf(s)
        val hostPort = if (s.contains(":")) s else "$s:$DEFAULT_PORT"
        return listOf("https://$hostPort", "http://$hostPort")
    }

    /** First candidate that answers /config 200 with the token, else null. Blocking. */
    fun resolve(input: String, token: String): String? {
        for (base in candidates(input)) if (validate(base, token)) return base
        return null
    }

    /** Redeem a pairing code at the server for a device token. Probes https then
     *  http. Returns (baseUrl, token) on success, else null. Blocking. */
    fun redeemCode(input: String, code: String): Pair<String, String>? {
        val client = OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .callTimeout(6, TimeUnit.SECONDS)
            .build()
        val payload = JSONObject().put("code", code.trim()).toString()
            .toRequestBody("application/json".toMediaType())
        for (base in candidates(input)) {
            try {
                val req = Request.Builder().url("$base/auth/pair-code/redeem").post(payload).build()
                client.newCall(req).execute().use { r ->
                    if (r.isSuccessful) {
                        val token = JSONObject(r.body?.string() ?: "").optString("token")
                        if (token.isNotEmpty()) return base to token
                    }
                }
            } catch (_: Exception) {}
        }
        return null
    }

    /** For the adb pairing hook only: ensure a usable base URL (defaults http + :3001). */
    fun normalizeUrl(input: String): String {
        var s = input.trim().trimEnd('/')
        if (s.isEmpty()) return s
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        if (s.startsWith("http://") && !s.substringAfter("://").contains(":")) s = "$s:$DEFAULT_PORT"
        return s
    }

    /**
     * Confirm a URL + token actually pair: GET /config with the bearer token
     * returns 200 only when both the server and the token are valid. Blocking.
     */
    fun validate(url: String, token: String): Boolean {
        return try {
            val client = OkHttpClient.Builder()
                .connectTimeout(4, TimeUnit.SECONDS)
                .callTimeout(6, TimeUnit.SECONDS)
                .build()
            val req = Request.Builder().url("$url/config")
                .addHeader("Authorization", "Bearer $token").build()
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (_: Exception) {
            false
        }
    }
}

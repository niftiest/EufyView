package com.eufyview.tv

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * In-app self-update for the TV app.
 *
 * The app asks its own EufyView server (`GET /updates/tv`, authenticated with the
 * device token) for the latest released TV-APK versionCode + download URL. The
 * server reaches GitHub Releases and caches the answer, so every TV doesn't hit
 * GitHub directly. If the release is newer than what's installed, we download the
 * APK (straight from the release asset) and hand it to the system PackageInstaller,
 * which shows the on-screen confirm.
 *
 * NOTE: Android only installs an update over an existing app when both are signed
 * with the SAME certificate. Debug builds share the machine's debug keystore (fine
 * for self-rebuilds); for distribution, use a stable release keystore.
 */
object Updater {
    data class Info(val versionCode: Int, val versionName: String, val url: String)

    private val http = OkHttpClient()

    fun installedVersionCode(ctx: Context): Int = try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt()
        else @Suppress("DEPRECATION") pi.versionCode
    } catch (e: Exception) { 0 }

    /**
     * Ask the server for the latest TV release. Returns Info only when it is
     * NEWER than the installed build, else null. Blocking - call off the UI thread.
     */
    fun checkForUpdate(ctx: Context, prefs: Prefs): Info? {
        val base = prefs.serverUrl
        val token = prefs.token
        if (base.isBlank() || token.isBlank()) return null
        return try {
            val req = Request.Builder().url("$base/updates/tv")
                .header("Authorization", "Bearer $token").build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val j = JSONObject(resp.body?.string() ?: return null)
                if (!j.optBoolean("available")) return null
                val vc = j.optInt("versionCode", -1)
                val url = j.optString("url", "")
                if (vc <= installedVersionCode(ctx) || url.isBlank()) return null
                Info(vc, j.optString("versionName", ""), url)
            }
        } catch (e: Exception) { null }
    }

    /**
     * Download the APK and commit it to a PackageInstaller session; the system
     * then shows the install confirmation. Blocking - call off the UI thread.
     * Returns null on success (install UI launched) or an error message.
     */
    fun downloadAndInstall(ctx: Context, info: Info): String? {
        return try {
            val req = Request.Builder().url(info.url).build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return "download failed (${resp.code})"
                val body = resp.body ?: return "empty download"
                val len = body.contentLength()
                val installer = ctx.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL
                )
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    session.openWrite("eufyview-tv.apk", 0, if (len > 0) len else -1).use { out ->
                        body.byteStream().copyTo(out)
                        session.fsync(out)
                    }
                    val intent = Intent(ctx, MainActivity::class.java)
                        .setAction("com.eufyview.tv.INSTALL_RESULT")
                    val flags = if (Build.VERSION.SDK_INT >= 31)
                        PendingIntent.FLAG_MUTABLE else 0
                    val pending = PendingIntent.getActivity(ctx, sessionId, intent, flags)
                    session.commit(pending.intentSender)
                }
            }
            null
        } catch (e: Exception) {
            e.message ?: "install failed"
        }
    }
}

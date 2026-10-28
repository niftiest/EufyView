package com.eufyview.tv

import android.content.Context

/** A camera the app knows about: friendly name + its house (house may be empty). */
data class CameraInfo(val name: String, val house: String)

/**
 * All persisted settings for the TV alert app, in one SharedPreferences file.
 *
 * Filters follow an "empty = everything" rule so a fresh install alerts on all
 * cameras and all event types until the user narrows it down:
 *  - enabledCameras: set of camera serials to alert on (empty = all cameras)
 *  - enabledTypes:   set of category keys to alert on   (empty = all types)
 *
 * knownCameras is a serial -> name map the service fills in as detections arrive,
 * so the settings screen can show real camera names to pick from.
 */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("eufyview_tv", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(KEY_URL, "") ?: ""
        set(v) = sp.edit().putString(KEY_URL, v.trim().trimEnd('/')).apply()

    var token: String
        get() = sp.getString(KEY_TOKEN, "") ?: ""
        set(v) = sp.edit().putString(KEY_TOKEN, v.trim()).apply()

    var bannerSeconds: Int
        get() = sp.getInt(KEY_SECONDS, 11)
        set(v) = sp.edit().putInt(KEY_SECONDS, v).apply()

    var enabledCameras: Set<String>
        get() = sp.getStringSet(KEY_CAMS, emptySet()) ?: emptySet()
        set(v) = sp.edit().putStringSet(KEY_CAMS, v).apply()

    var enabledTypes: Set<String>
        get() = sp.getStringSet(KEY_TYPES, emptySet()) ?: emptySet()
        set(v) = sp.edit().putStringSet(KEY_TYPES, v).apply()

    val isConfigured: Boolean get() = serverUrl.isNotEmpty() && token.isNotEmpty()

    // Set true only after a server URL + token have been validated against the
    // server at least once. The app's onboarding screen blocks until this is true.
    var paired: Boolean
        get() = sp.getBoolean(KEY_PAIRED, false)
        set(v) = sp.edit().putBoolean(KEY_PAIRED, v).apply()

    /** Remember a camera (from the server's device catalog, or an event) for the
     *  settings picker: friendly name + house, keyed by serial. */
    fun rememberCamera(serial: String, name: String?, house: String? = null) {
        if (serial.isEmpty()) return
        val map = knownCameras().toMutableMap()
        val existing = map[serial]
        val newName = name?.takeIf { it.isNotBlank() } ?: existing?.name ?: serial
        val newHouse = house?.takeIf { it.isNotBlank() } ?: existing?.house ?: ""
        val updated = CameraInfo(newName, newHouse)
        if (existing == updated) return
        map[serial] = updated
        // serial\u0001name\u0001house triples joined by \u0002
        val packed = map.entries.joinToString("\u0002") { "${it.key}\u0001${it.value.name}\u0001${it.value.house}" }
        sp.edit().putString(KEY_KNOWN, packed).apply()
    }

    fun knownCameras(): Map<String, CameraInfo> {
        val raw = sp.getString(KEY_KNOWN, "") ?: ""
        if (raw.isEmpty()) return emptyMap()
        return raw.split("\u0002").mapNotNull {
            val p = it.split("\u0001")
            when {
                p.size >= 3 -> p[0] to CameraInfo(p[1], p[2])
                p.size == 2 -> p[0] to CameraInfo(p[1], "")   // pre-house format
                else -> null
            }
        }.toMap()
    }

    /** Does a detection on (serial, categoryKey) pass the current filters? */
    fun passes(serial: String, categoryKey: String): Boolean {
        val cams = enabledCameras
        if (cams.isNotEmpty() && !cams.contains(serial)) return false
        val types = enabledTypes
        if (types.isNotEmpty() && !types.contains(categoryKey)) return false
        return true
    }

    companion object {
        private const val KEY_URL = "serverUrl"
        private const val KEY_TOKEN = "token"
        private const val KEY_SECONDS = "bannerSeconds"
        private const val KEY_CAMS = "enabledCameras"
        private const val KEY_TYPES = "enabledTypes"
        private const val KEY_KNOWN = "knownCameras"
        private const val KEY_PAIRED = "paired"
    }
}

package com.eufyview.tv

/**
 * Maps a detection's server-side `event`/`label` text to one of a small set of
 * user-facing categories, so the settings screen can offer the same per-type
 * filtering the phone app has (person / ring / pet / vehicle / package / sound /
 * motion). Matching is keyword-based and case-insensitive; anything unrecognised
 * falls back to "motion" so it still alerts under the default (empty) filter.
 */
object Categories {

    data class Category(val key: String, val label: String)

    // Order = display order in the settings screen.
    val ALL = listOf(
        Category("person", "Person"),
        Category("ring", "Doorbell ring"),
        Category("pet", "Pet"),
        Category("vehicle", "Vehicle"),
        Category("package", "Package"),
        Category("sound", "Sound / crying"),
        Category("motion", "Motion / other")
    )

    fun labelFor(key: String): String = ALL.firstOrNull { it.key == key }?.label ?: key

    fun categorize(event: String?, label: String?): String {
        val s = ((event ?: "") + " " + (label ?: "")).lowercase()
        return when {
            s.contains("ring") || s.contains("doorbell") -> "ring"
            s.contains("person") || s.contains("stranger") || s.contains("face") -> "person"
            s.contains("pet") || s.contains("dog") || s.contains("cat") -> "pet"
            s.contains("vehicle") || s.contains("car") -> "vehicle"
            s.contains("package") || s.contains("parcel") -> "package"
            s.contains("sound") || s.contains("cry") || s.contains("baby") -> "sound"
            else -> "motion"
        }
    }
}

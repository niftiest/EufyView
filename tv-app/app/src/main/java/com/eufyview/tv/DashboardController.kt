package com.eufyview.tv

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * Drives the dashboard home screen: pulls the camera catalog + live detections
 * from [CatalogClient], lays the cameras out as house-grouped card rows (plus a
 * "Recent activity" row once something fires), keeps a big hero image in sync
 * with whichever card has focus, and opens the live view when a card is chosen.
 *
 * Owned by MainActivity; start()/stop() follow the activity's visibility so the
 * UI's WebSocket only runs while the dashboard is on screen (the background
 * AlertService is what keeps alerts flowing otherwise).
 */
class DashboardController(private val activity: Activity, private val prefs: Prefs) {

    private val main = Handler(Looper.getMainLooper())
    private val serverUrl = prefs.serverUrl
    private val token = prefs.token

    private val heroImage: ImageView = activity.findViewById(R.id.hero_image)
    private val heroTitle: TextView = activity.findViewById(R.id.hero_title)
    private val heroSubtitle: TextView = activity.findViewById(R.id.hero_subtitle)
    private val heroHint: TextView = activity.findViewById(R.id.hero_hint)
    private val statusView: TextView = activity.findViewById(R.id.dash_status)
    private val emptyView: TextView = activity.findViewById(R.id.dash_empty)
    private val rowsRecycler: RecyclerView = activity.findViewById(R.id.rows_recycler)

    private val cameras = LinkedHashMap<String, Camera>()   // serial -> camera (insertion order)
    private val rows = ArrayList<Row>()
    private var heroSerial: String? = null
    private var pendingRebuild = false
    // The camera focus should land on after a (re)build - the last-focused card,
    // or the one we just watched. Keeps the user's place across reconnect
    // rebuilds, detection rebuilds, and returning from the live view.
    private var pendingFocusSerial: String? = null

    private val client = CatalogClient(
        serverUrl, token,
        onCatalog = ::applyCatalog,
        onDetection = ::onDetection,
        onStatus = { statusView.text = it }
    )

    init {
        rowsRecycler.layoutManager = LinearLayoutManager(activity, LinearLayoutManager.VERTICAL, false)
    }

    fun start() {
        // Returning from the live view: rebuild from the cameras we already have so
        // the "Recently viewed" row and focus restore happen instantly, rather than
        // waiting for the WebSocket to reconnect and re-send the catalog.
        if (cameras.isNotEmpty()) buildAndBind()
        client.start()
    }

    fun stop() { client.stop(); main.removeCallbacksAndMessages(null) }

    // ---- data in ----

    private fun applyCatalog(list: List<Camera>) {
        // Merge: keep any detection state we've already recorded for a serial.
        for (c in list) {
            val existing = cameras[c.serial]
            cameras[c.serial] = if (existing == null) c
                else c.copy(lastLabel = existing.lastLabel, lastEventAt = existing.lastEventAt)
        }
        if (cameras.isEmpty()) { buildAndBind(); return }
        // First load only: seed the hero so it isn't blank before focus lands
        // (after that the hero follows focus). Prefer a recently-viewed camera,
        // then a recently-active one, else the first.
        if (heroSerial == null) {
            val initial = cameras.values.maxByOrNull { it.lastEventAt }?.takeIf { it.lastEventAt > 0 }
                ?: cameras.values.first()
            setHero(initial)
        }
        buildAndBind()   // builds rows + restores focus
    }

    private fun onDetection(serial: String, name: String, label: String, timeMs: Long) {
        val cam = cameras[serial]
        val isNew = cam == null
        if (cam != null) {
            cam.lastLabel = label
            cam.lastEventAt = timeMs
        } else {
            // A camera we didn't have in the catalog yet - add it so it shows up.
            cameras[serial] = Camera(serial, name, "", label, timeMs)
        }
        // Live-update the hero if it's showing this camera.
        if (heroSerial == serial) heroSubtitle.text = subtitleFor(cameras[serial]!!)
        // Only a never-before-seen camera changes the layout; an ordinary detection
        // doesn't add/reorder any row now, so don't rebuild (and don't disturb focus).
        if (isNew && !pendingRebuild) {
            pendingRebuild = true
            main.postDelayed({ pendingRebuild = false; buildAndBind() }, 1200)
        }
    }

    // ---- layout ----

    private fun buildAndBind() {
        emptyView.visibility = if (cameras.isEmpty()) View.VISIBLE else View.GONE
        rows.clear()

        // House-grouped rows. Cameras with no house fall under "Cameras".
        val byHouse = LinkedHashMap<String, MutableList<Camera>>()
        for (c in cameras.values) {
            val key = c.house.ifBlank { "" }
            byHouse.getOrPut(key) { ArrayList() }.add(c)
        }
        val houseKeys = byHouse.keys.sortedWith(compareBy({ it.isEmpty() }, { it.lowercase() }))
        val multiHouse = byHouse.keys.count { it.isNotEmpty() } > 0
        for (k in houseKeys) {
            val title = if (k.isEmpty()) (if (multiHouse) "Other cameras" else "Cameras") else k
            val cams = byHouse[k]!!.sortedBy { it.name.lowercase() }.toMutableList()
            rows.add(Row("house:$k", title, cams))
        }

        rowsRecycler.adapter = RowAdapter(serverUrl, token, rows, ::openLive, ::onCardFocused)
        if (cameras.isNotEmpty()) restoreFocus(pendingFocusSerial)
    }

    // Put focus back on [serial]'s card (e.g. the camera just watched), scrolling
    // its house row into view first since it may be lower down. Falls back to the
    // first card if the camera isn't in the current rows.
    private fun restoreFocus(serial: String?) {
        if (serial == null) { focusFirstCard(3); return }
        var rowIndex = -1; var cardIndex = -1
        for (r in rows.indices) {
            val idx = rows[r].cameras.indexOfFirst { it.serial == serial }
            if (idx >= 0) { rowIndex = r; cardIndex = idx; break }
        }
        if (rowIndex < 0) { focusFirstCard(3); return }
        rowsRecycler.scrollToPosition(rowIndex)
        focusRowCard(rowIndex, cardIndex, 10)
    }

    // Retries because the fresh RowAdapter (and the scroll) lay children out a
    // frame or two later.
    private fun focusRowCard(rowIndex: Int, cardIndex: Int, triesLeft: Int) {
        if (triesLeft <= 0) { focusFirstCard(2); return }
        main.postDelayed({
            val rowVh = rowsRecycler.findViewHolderForAdapterPosition(rowIndex) as? RowAdapter.VH
            if (rowVh == null) { focusRowCard(rowIndex, cardIndex, triesLeft - 1); return@postDelayed }
            rowVh.cards.scrollToPosition(cardIndex)
            val cardVh = rowVh.cards.findViewHolderForAdapterPosition(cardIndex)
            if (cardVh != null) cardVh.itemView.requestFocus()
            else focusRowCard(rowIndex, cardIndex, triesLeft - 1)
        }, 110)
    }

    private fun focusFirstCard(triesLeft: Int) {
        if (triesLeft <= 0) return
        main.postDelayed({
            val rowVh = rowsRecycler.findViewHolderForAdapterPosition(0) as? RowAdapter.VH
            val firstCard = rowVh?.cards?.findViewHolderForAdapterPosition(0)?.itemView
            if (firstCard != null) firstCard.requestFocus()
            else focusFirstCard(triesLeft - 1)
        }, 120)
    }

    // A card gained focus → remember it (so rebuilds keep the user's place) and
    // retune the hero to that camera.
    private fun onCardFocused(cam: Camera) {
        pendingFocusSerial = cam.serial
        setHero(cam)
    }

    // ---- hero ----

    private fun setHero(cam: Camera) {
        heroSerial = cam.serial
        heroTitle.text = cam.name
        heroSubtitle.text = subtitleFor(cam)
        heroHint.text = "Press OK to watch live"
        ImageLoader.load(heroImage, "$serverUrl/snapshot/${cam.serial}.jpg", token, R.drawable.card_placeholder)
    }

    private fun subtitleFor(cam: Camera): String {
        val house = cam.house.takeIf { it.isNotBlank() }
        val event = cam.lastLabel?.let { "$it · ${relativeTime(cam.lastEventAt)}" }
        return listOfNotNull(house, event ?: "Live").joinToString("   ·   ")
    }

    private fun relativeTime(t: Long): String {
        if (t <= 0) return ""
        val s = (System.currentTimeMillis() - t) / 1000
        return when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60}m ago"
            s < 86400 -> "${s / 3600}h ago"
            else -> "${s / 86400}d ago"
        }
    }

    // ---- actions ----

    private fun openLive(cam: Camera) {
        // Remember it: surfaces in "Recently viewed" and is where focus returns.
        pendingFocusSerial = cam.serial
        // Pass "House - Camera" (matching the alert path) so the live view can show
        // the house + camera on their own line.
        val title = if (cam.house.isNotBlank()) "${cam.house} - ${cam.name}" else cam.name
        activity.startActivity(Intent(activity, LiveActivity::class.java).apply {
            putExtra("serial", cam.serial)
            putExtra("name", title)
            putExtra("token", token)
            putExtra("url", serverUrl)
        })
    }
}

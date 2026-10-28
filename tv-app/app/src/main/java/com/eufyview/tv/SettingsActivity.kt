package com.eufyview.tv

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Setup screen: server + pairing token, notification duration, and the per-type /
 * per-camera alert filters. Filters are shown as horizontal, D-pad-friendly chip
 * rows (blue = on) grouped by house, so you scroll left/right through a house's
 * cameras instead of pressing down through a long vertical list. Empty selection
 * = everything, so a fresh install alerts on all cameras/types.
 */
class SettingsActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var urlField: EditText
    private lateinit var secondsField: EditText
    private val camChips = mutableMapOf<String, TextView>()
    private val typeChips = mutableMapOf<String, TextView>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_settings)

        urlField = findViewById(R.id.url_field)
        secondsField = findViewById(R.id.seconds_field)
        urlField.setText(Discovery.stripScheme(prefs.serverUrl))
        secondsField.setText(prefs.bannerSeconds.toString())

        buildTypeChips()
        buildCameraChips()

        findViewById<Button>(R.id.save_btn).setOnClickListener { save() }
        // Re-pair runs onboarding again (new pairing code) to swap servers/accounts.
        findViewById<Button>(R.id.repair_btn).setOnClickListener {
            startActivity(android.content.Intent(this, DiscoveryActivity::class.java))
            finish()
        }
        setupUpdateControl()
    }

    // "About & Updates" block appended to the settings column: shows the installed
    // version and a button that checks the server for a newer TV-app release and
    // installs it in place. Auto-checks quietly on open.
    private fun setupUpdateControl() {
        val row = findViewById<Button>(R.id.save_btn).parent as? ViewGroup ?: return
        val column = row.parent as? LinearLayout ?: return

        val installed = try { packageManager.getPackageInfo(packageName, 0).versionName } catch (e: Exception) { "?" }
        val status = TextView(this).apply {
            setTextColor(0xFFC7D4E6.toInt()); textSize = 14f
            setPadding(dp(6), dp(20), dp(6), dp(4))
            text = "Installed: v$installed"
        }
        val btn = Button(this).apply { text = "Check for updates"; isFocusable = true }
        column.addView(status); column.addView(btn)

        fun offerInstall(info: Updater.Info) {
            status.text = "Update available: v${info.versionName}"
            btn.text = "Download & install v${info.versionName}"
            btn.setOnClickListener {
                btn.isEnabled = false
                status.text = "Downloading…"
                Thread {
                    val err = Updater.downloadAndInstall(this, info)
                    runOnUiThread {
                        if (err != null) { status.text = "Update failed: $err"; btn.isEnabled = true }
                        else status.text = "Installing… confirm on screen."
                    }
                }.start()
            }
        }

        btn.setOnClickListener {
            status.text = "Checking…"
            Thread {
                val info = Updater.checkForUpdate(this, prefs)
                runOnUiThread { if (info == null) status.text = "You're on the latest version." else offerInstall(info) }
            }.start()
        }
        // Quiet auto-check on open.
        Thread {
            val info = Updater.checkForUpdate(this, prefs)
            if (info != null) runOnUiThread { offerInstall(info) }
        }.start()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // A focusable toggle chip. Blue when on; scales up a touch when focused so the
    // D-pad cursor is obvious on a TV.
    private fun makeChip(label: String, on: Boolean): TextView = TextView(this).apply {
        text = label
        isActivated = on
        setTextColor(if (on) 0xFFFFFFFF.toInt() else 0xFF9FB6D6.toInt())
        textSize = 15f
        setPadding(dp(18), dp(10), dp(18), dp(10))
        setBackgroundResource(R.drawable.chip_bg)
        isFocusable = true
        isClickable = true
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.marginEnd = dp(10)
        layoutParams = lp
        setOnClickListener {
            isActivated = !isActivated
            setTextColor(if (isActivated) 0xFFFFFFFF.toInt() else 0xFF9FB6D6.toInt())
        }
        setOnFocusChangeListener { v, f ->
            v.animate().scaleX(if (f) 1.08f else 1f).scaleY(if (f) 1.08f else 1f).setDuration(120).start()
        }
    }

    // A horizontal, auto-scrolling row to hold chips. The inner padding + no-clip
    // flags give the focus border/scale room so it isn't cut off at the edges.
    private fun makeRow(): Pair<HorizontalScrollView, LinearLayout> {
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(6), dp(12), dp(6), dp(12))
            clipChildren = false
            clipToPadding = false
        }
        val hsv = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            isFocusable = false
            clipChildren = false
            clipToPadding = false
            addView(inner)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        return hsv to inner
    }

    private fun buildTypeChips() {
        val container = findViewById<LinearLayout>(R.id.types_container)
        container.removeAllViews()
        val enabled = prefs.enabledTypes
        val (hsv, row) = makeRow()
        for (c in Categories.ALL) {
            val chip = makeChip(c.label, enabled.isEmpty() || enabled.contains(c.key))
            typeChips[c.key] = chip
            row.addView(chip)
        }
        container.addView(hsv)
    }

    private fun buildCameraChips() {
        val container = findViewById<LinearLayout>(R.id.cams_container)
        container.removeAllViews()
        val known = prefs.knownCameras()
        val enabled = prefs.enabledCameras
        if (known.isEmpty()) {
            container.addView(TextView(this).apply {
                text = "No cameras yet. Leave this (it alerts on all cameras); once the app " +
                    "has connected to the server, reopen Settings to pick specific ones."
                setTextColor(0xFFC7D4E6.toInt())
            })
            return
        }
        // One horizontal row per house; cameras with no house go under "Other".
        val byHouse = known.entries.groupBy { it.value.house }
        val houseOrder = byHouse.keys.sortedBy { if (it.isEmpty()) "~" else it.lowercase() }
        for (house in houseOrder) {
            container.addView(TextView(this).apply {
                text = if (house.isEmpty()) "Other" else house
                setTextColor(0xFFFFFFFF.toInt())
                textSize = 17f
                setTypeface(typeface, Typeface.BOLD)
                setPadding(0, dp(16), 0, dp(4))
            })
            val (hsv, row) = makeRow()
            for (e in byHouse[house]!!.sortedBy { it.value.name.lowercase() }) {
                val chip = makeChip(e.value.name, enabled.isEmpty() || enabled.contains(e.key))
                camChips[e.key] = chip
                row.addView(chip)
            }
            container.addView(hsv)
        }
    }

    private fun save() {
        val input = urlField.text.toString().trim()
        val token = prefs.token   // set during pairing; we never ask the user to type it
        if (input.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "Enter the server IP:port (and pair the TV if you haven't).", Toast.LENGTH_LONG).show()
            return
        }
        prefs.bannerSeconds = secondsField.text.toString().toIntOrNull() ?: 11

        // "All on" (or none) is stored as empty = no filter, so newly-added cameras
        // aren't silently excluded later.
        val cams = camChips.filterValues { it.isActivated }.keys
        prefs.enabledCameras = if (camChips.isNotEmpty() && cams.size < camChips.size) cams else emptySet()
        val types = typeChips.filterValues { it.isActivated }.keys
        prefs.enabledTypes = if (types.size < typeChips.size) types else emptySet()

        // Resolve http/https for the entered host:port, then save + reconnect.
        Toast.makeText(this, "Saving…", Toast.LENGTH_SHORT).show()
        Thread {
            val working = Discovery.resolve(input, token)
            runOnUiThread {
                if (working != null) {
                    prefs.serverUrl = working
                    prefs.token = token
                    AlertService.start(this)
                    Toast.makeText(this, "Saved - connecting", Toast.LENGTH_SHORT).show()
                    finish()
                } else {
                    Toast.makeText(this, "Filters saved, but couldn't reach a server at $input with that token.", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }
}

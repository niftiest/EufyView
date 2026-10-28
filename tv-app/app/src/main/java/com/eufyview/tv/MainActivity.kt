package com.eufyview.tv

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button

/**
 * Launcher = the dashboard home. Handles the headless pairing hook and the
 * "not paired yet → onboarding" gate exactly as before, then shows the
 * Netflix-style camera dashboard (hero + card rows) when configured. The
 * background AlertService is started independently so alerts keep flowing even
 * when this screen isn't open.
 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var dashboard: DashboardController? = null
    private var overlayBtn: Button? = null

    private val poll = object : Runnable {
        override fun run() {
            overlayBtn?.visibility = if (needsOverlay()) View.VISIBLE else View.GONE
            main.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        // Headless pairing hook (handy on a TV where typing a long token is painful):
        //   adb shell am start -n com.eufyview.tv/.MainActivity \
        //     -e url https://your-host -e token <paste>
        intent?.let {
            val u = it.getStringExtra("url"); val t = it.getStringExtra("token")
            if (!u.isNullOrBlank()) prefs.serverUrl = Discovery.normalizeUrl(u)
            if (!t.isNullOrBlank()) prefs.token = t
            if (!u.isNullOrBlank() && !t.isNullOrBlank()) {
                prefs.paired = true
                AlertService.start(this)
                // Installer path: pair with NO UI on the TV (don't flash a screen).
                if (it.getStringExtra("silent") == "true") { finish(); return }
            }
        }

        // Gate: until a server + token have paired, send the user to onboarding.
        if (!prefs.paired) {
            startActivity(Intent(this, DiscoveryActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_dashboard)

        findViewById<Button>(R.id.settings_btn).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // Quietly notice a newer TV-app release; nudge toward Settings to install.
        Thread {
            val info = Updater.checkForUpdate(this, prefs)
            if (info != null) runOnUiThread {
                android.widget.Toast.makeText(
                    this,
                    "EufyView update available (v${info.versionName}) - open Settings to install.",
                    android.widget.Toast.LENGTH_LONG
                ).show()
            }
        }.start()
        overlayBtn = findViewById(R.id.overlay_btn)
        overlayBtn?.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        }

        dashboard = DashboardController(this, prefs)
    }

    override fun onResume() {
        super.onResume()
        if (prefs.isConfigured) AlertService.start(this)
        dashboard?.start()
        poll.run()
    }

    override fun onPause() {
        super.onPause()
        main.removeCallbacks(poll)
        dashboard?.stop()
    }

    private fun needsOverlay(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)
}

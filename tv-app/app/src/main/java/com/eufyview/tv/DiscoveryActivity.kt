package com.eufyview.tv

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

/**
 * First-run / unpaired gate. Auto-scans the LAN for the EufyView server, offers
 * manual IP entry + rescan if nothing's found, and only lets the user proceed
 * once a URL + token actually pair against the server. Shown by MainActivity
 * whenever prefs.paired is false.
 */
class DiscoveryActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var ipField: EditText
    private lateinit var codeField: EditText
    private lateinit var scanBtn: Button
    private lateinit var pairBtn: Button
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_discovery)
        status = findViewById(R.id.disc_status)
        ipField = findViewById(R.id.disc_ip)
        codeField = findViewById(R.id.disc_code)
        scanBtn = findViewById(R.id.disc_scan)
        pairBtn = findViewById(R.id.disc_pair)

        if (prefs.serverUrl.isNotEmpty()) ipField.setText(Discovery.stripScheme(prefs.serverUrl))

        scanBtn.setOnClickListener { scan() }
        pairBtn.setOnClickListener { pair() }

        scan()   // auto-scan on load
    }

    private fun setBusy(b: Boolean) {
        busy = b
        scanBtn.isEnabled = !b
        pairBtn.isEnabled = !b
    }

    private fun scan() {
        if (busy) return
        setBusy(true)
        status.text = "Scanning your network for the EufyView server…"
        Thread {
            val results = Discovery.scan(Discovery.DEFAULT_PORT) { done, total ->
                if (done % 32 == 0 || done == total) runOnUiThread { status.text = "Scanning… $done/$total" }
            }
            runOnUiThread {
                setBusy(false)
                if (results.isNotEmpty()) {
                    val best = results.first()
                    ipField.setText(Discovery.stripScheme(best.url))
                    val extra = if (results.size > 1) " (${results.size} servers found)" else ""
                    status.text = "Found EufyView at ${best.ip}$extra\nEnter the pairing code below, then press Pair."
                } else {
                    status.text = "No server found on this network.\nEnter the server IP manually (e.g. 10.0.0.50) and press Pair, or Scan again."
                }
            }
        }.start()
    }

    private fun pair() {
        if (busy) return
        val input = ipField.text.toString().trim()
        val code = codeField.text.toString().trim()
        if (input.isEmpty()) {
            Toast.makeText(this, "Enter the server IP:port first", Toast.LENGTH_LONG).show()
            return
        }
        if (code.isEmpty()) {
            Toast.makeText(this, "Enter the 6-digit pairing code from the web app", Toast.LENGTH_LONG).show()
            return
        }
        setBusy(true)
        status.text = "Pairing with $input…"
        Thread {
            // Redeem the code for a device token (probes https then http).
            val result = Discovery.redeemCode(input, code)
            runOnUiThread {
                setBusy(false)
                if (result != null) {
                    prefs.serverUrl = result.first
                    prefs.token = result.second
                    prefs.paired = true
                    AlertService.start(this)
                    startActivity(Intent(this, MainActivity::class.java))
                    finish()
                } else {
                    status.text = "That code didn't work. Make sure the server IP:port is right and the code is current (they expire after 5 minutes), then get a fresh code and try again."
                }
            }
        }.start()
    }
}

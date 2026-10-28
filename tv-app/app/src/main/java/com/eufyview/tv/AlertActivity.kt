package com.eufyview.tv

import android.app.Activity
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Full-screen fallback alert, used when the over-other-apps overlay permission
 * isn't granted. Shows the same banner content and auto-closes.
 */
class AlertActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.overlay_banner)

        val title = intent.getStringExtra("title") ?: "Detection"
        val subtitle = intent.getStringExtra("subtitle") ?: ""
        val snapUrl = intent.getStringExtra("snapUrl")
        val token = intent.getStringExtra("token") ?: ""
        val seconds = intent.getIntExtra("seconds", 11)

        findViewById<TextView>(R.id.banner_title).text = title
        findViewById<TextView>(R.id.banner_subtitle).text = subtitle
        val img = findViewById<ImageView>(R.id.banner_image)
        if (snapUrl != null) fetch(snapUrl, token, img)

        main.postDelayed({ finish() }, seconds.coerceIn(3, 60) * 1000L)
    }

    private fun fetch(url: String, token: String, img: ImageView) {
        val req = Request.Builder().url(url).addHeader("Authorization", "Bearer $token").build()
        Thread {
            var attempt = 0
            while (attempt < 3) {
                try {
                    http.newCall(req).execute().use { resp ->
                        val bytes = if (resp.isSuccessful) resp.body?.bytes() else null
                        if (bytes != null && bytes.isNotEmpty()) {
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) {
                                main.post { img.setImageBitmap(bmp); img.visibility = View.VISIBLE }
                                return@Thread
                            }
                        }
                    }
                } catch (_: Exception) {}
                attempt++
                try { Thread.sleep(2500) } catch (_: InterruptedException) { return@Thread }
            }
        }.start()
    }
}

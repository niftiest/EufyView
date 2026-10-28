package com.eufyview.tv

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Draws the detection banner. Preferred path is a system overlay drawn over
 * whatever's on screen (needs SYSTEM_ALERT_WINDOW / "draw over other apps"); if
 * that isn't granted we fall back to a transparent full-screen Activity so the
 * alert still shows. A new alert replaces the one on screen.
 */
object OverlayManager {
    private val main = Handler(Looper.getMainLooper())
    private var current: View? = null
    private var dismiss: Runnable? = null
    private var pipView: View? = null
    private var pipPlayer: ExoPlayer? = null
    private var pipDismiss: Runnable? = null

    // Burst coalescing: one real-world detection fans out into several events
    // (familiar face → person → motion) within a few hundred ms. We show ONE
    // banner for the burst - the most specific one - instead of letting the
    // last/least-specific event (Motion) overwrite it. Track the camera + the
    // rank currently on screen; a same-camera event within the window that is
    // not more specific is dropped (so it neither downgrades the text nor
    // re-pops over an open PiP).
    private const val COALESCE_MS = 12000L
    private var lastSerial: String? = null
    private var lastRank: Int = 0
    private var lastShownAt: Long = 0L

    fun show(
        ctx: Context,
        http: OkHttpClient,
        token: String,
        serverUrl: String,
        serial: String,
        title: String,
        subtitle: String,
        snapUrl: String?,
        seconds: Int,
        rank: Int = 3
    ) {
        val now = System.currentTimeMillis()
        if (serial == lastSerial && now - lastShownAt < COALESCE_MS && rank <= lastRank) {
            // Same detection burst, equal or less specific than what's already
            // shown - keep the better banner, ignore this one.
            return
        }
        lastSerial = serial
        lastRank = rank
        lastShownAt = now

        val canOverlay = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)
        if (!canOverlay) {
            // No overlay permission → full-screen Activity fallback.
            val i = Intent(ctx, AlertActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra("title", title)
                putExtra("subtitle", subtitle)
                putExtra("snapUrl", snapUrl)
                putExtra("token", token)
                putExtra("seconds", seconds)
                putExtra("serial", serial)
                putExtra("url", serverUrl)
            }
            ctx.startActivity(i)
            return
        }

        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        removeCurrent(wm)
        removePip(wm)   // a new alert closes any open PiP peek

        val view = LayoutInflater.from(ctx).inflate(R.layout.overlay_banner, null)
        view.findViewById<TextView>(R.id.banner_title).text = title
        view.findViewById<TextView>(R.id.banner_subtitle).text = "$subtitle  ·  OK to view live"
        val img = view.findViewById<ImageView>(R.id.banner_image)

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_SYSTEM_ALERT

        // Focusable (NO FLAG_NOT_FOCUSABLE) so the remote's OK/Back reach the
        // banner - this briefly captures the D-pad while the toast is up; it's
        // released when the toast dismisses.
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        // Pin top-right like a system toast, inset to clear TV overscan.
        lp.gravity = Gravity.TOP or Gravity.END
        val inset = (32 * ctx.resources.displayMetrics.density).toInt()
        lp.x = inset
        lp.y = inset

        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.setOnKeyListener { _, keyCode, event ->
            if (event.action != KeyEvent.ACTION_UP) return@setOnKeyListener false
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    dismiss?.let { main.removeCallbacks(it) }         // cancel the pending auto-dismiss
                    dismiss = null
                    removeCurrent(wm)                                 // close the toast NOW…
                    // …and build the PiP on the next loop tick. Constructing ExoPlayer +
                    // prepare() is ~100-300ms of main-thread work; doing it inline would
                    // stall the frame that paints the toast's removal, so the banner would
                    // appear to "sit" until the player was ready. Deferring lets the
                    // removeView traversal draw first, so the toast vanishes immediately.
                    main.post { showPip(ctx, serverUrl, serial, token, title) }
                    true
                }
                KeyEvent.KEYCODE_BACK -> { removeCurrent(wm); true }
                else -> false
            }
        }

        try {
            wm.addView(view, lp)
            current = view
            view.requestFocus()
        } catch (e: Exception) {
            return
        }

        if (snapUrl != null) fetchSnapshot(http, token, snapUrl, img, tries = 3)

        dismiss?.let { main.removeCallbacks(it) }
        val r = Runnable { removeCurrent(wm) }
        dismiss = r
        main.postDelayed(r, seconds.coerceIn(3, 60) * 1000L)
    }

    // Picture-in-picture "peek": a small muted live view drawn over the current app.
    // OK → expand to full-screen (with audio); Back → close. Auto-dismisses after 2 min.
    // Note: apps using a secure surface (DRM video - Netflix/Disney+ etc.) can suppress
    // overlays, so the PiP may not appear over them; full-screen (OK again) still works.
    @OptIn(UnstableApi::class)
    private fun showPip(ctx: Context, serverUrl: String, serial: String, token: String, title: String) {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        removePip(wm)

        val view = LayoutInflater.from(ctx).inflate(R.layout.overlay_pip, null)
        view.findViewById<TextView>(R.id.pip_title).text = title
        val status = view.findViewById<TextView>(R.id.pip_status)
        status.text = "Connecting…"
        val surface = view.findViewById<SurfaceView>(R.id.pip_surface)

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_SYSTEM_ALERT

        val dm = ctx.resources.displayMetrics
        val w = (dm.widthPixels / 3).coerceAtLeast((360 * dm.density).toInt())
        val h = w * 9 / 16
        val lp = WindowManager.LayoutParams(
            w, h, type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.END
        val inset = (24 * dm.density).toInt()
        lp.x = inset
        lp.y = inset

        val httpFactory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
            .setAllowCrossProtocolRedirects(true)
        val player = ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        pipPlayer = player
        player.volume = 0f   // muted so it doesn't fight the current app's audio
        player.setVideoSurfaceView(surface)
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                status.visibility = if (state == Player.STATE_READY) View.GONE else View.VISIBLE
                if (state == Player.STATE_BUFFERING) status.text = "Connecting…"
            }
        })
        player.setMediaItem(MediaItem.fromUri("$serverUrl/$serial.mp4"))
        player.prepare()
        player.playWhenReady = true

        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.setOnKeyListener { _, keyCode, event ->
            if (event.action != KeyEvent.ACTION_UP) return@setOnKeyListener false
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    try {
                        ctx.startActivity(Intent(ctx, LiveActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            putExtra("serial", serial)
                            putExtra("name", title)
                            putExtra("token", token)
                            putExtra("url", serverUrl)
                        })
                    } catch (_: Exception) {}
                    removePip(wm)
                    true
                }
                KeyEvent.KEYCODE_BACK -> { removePip(wm); true }
                else -> false
            }
        }

        try {
            wm.addView(view, lp)
            pipView = view
            view.requestFocus()
        } catch (e: Exception) {
            player.release(); pipPlayer = null; return
        }

        pipDismiss?.let { main.removeCallbacks(it) }
        val r = Runnable { removePip(wm) }
        pipDismiss = r
        main.postDelayed(r, 120000)
    }

    private fun removePip(wm: WindowManager) {
        pipDismiss?.let { main.removeCallbacks(it) }
        pipDismiss = null
        pipPlayer?.let { try { it.release() } catch (_: Exception) {} }
        pipPlayer = null
        pipView?.let { try { wm.removeView(it) } catch (_: Exception) {} }
        pipView = null
    }

    private fun removeCurrent(wm: WindowManager) {
        current?.let { try { wm.removeView(it) } catch (_: Exception) {} }
        current = null
    }

    // The event snapshot is written server-side a beat after the detection, so a
    // first fetch may 404 - retry a couple of times before giving up (text-only).
    private fun fetchSnapshot(http: OkHttpClient, token: String, url: String, img: ImageView, tries: Int) {
        val req = Request.Builder().url(url).addHeader("Authorization", "Bearer $token").build()
        Thread {
            var attempt = 0
            while (attempt < tries) {
                try {
                    http.newCall(req).execute().use { resp ->
                        if (resp.isSuccessful) {
                            val bytes = resp.body?.bytes()
                            if (bytes != null && bytes.isNotEmpty()) {
                                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                                if (bmp != null) {
                                    main.post {
                                        img.setImageBitmap(bmp)
                                        img.visibility = View.VISIBLE
                                    }
                                    return@Thread
                                }
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

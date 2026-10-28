package com.eufyview.tv

import android.app.Activity
import android.os.Bundle
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/**
 * Full-screen live view, launched from a tapped alert. Plays the camera's
 * progressive fMP4 feed (GET /<serial>.mp4) with ExoPlayer, sending the device
 * token as a bearer header. Back closes it and returns to whatever was on screen.
 */
class LiveActivity : Activity() {
    private var player: ExoPlayer? = null

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_live)

        val serial = intent.getStringExtra("serial")
        val name = intent.getStringExtra("name") ?: serial ?: "Camera"
        val token = intent.getStringExtra("token") ?: ""
        val base = intent.getStringExtra("url") ?: ""
        val status = findViewById<TextView>(R.id.live_status)
        val surface = findViewById<SurfaceView>(R.id.live_surface)
        if (serial.isNullOrEmpty() || base.isEmpty()) { finish(); return }
        status.text = "Connecting…\n$name"

        val httpFactory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
            .setAllowCrossProtocolRedirects(true)
        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        player = p
        p.setVideoSurfaceView(surface)
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> status.visibility = View.GONE
                    Player.STATE_BUFFERING -> {
                        status.text = "Connecting…\n$name"
                        status.visibility = View.VISIBLE
                    }
                    else -> {}
                }
            }
            override fun onPlayerError(error: PlaybackException) {
                status.text = "Couldn't load\n$name\n${error.message ?: ""}"
                status.visibility = View.VISIBLE
            }
        })
        p.setMediaItem(MediaItem.fromUri("$base/$serial.mp4"))
        p.prepare()
        p.playWhenReady = true
    }

    override fun onStop() {
        super.onStop()
        player?.playWhenReady = false
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }
}

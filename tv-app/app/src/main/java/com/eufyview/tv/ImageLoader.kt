package com.eufyview.tv

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Minimal async image loader for the dashboard - fetches a camera snapshot over
 * HTTP with the bearer token, decodes it off the main thread, and sets it on an
 * ImageView. Kept deliberately tiny (no Glide/Coil) since we only ever show a
 * handful of camera tiles plus one hero image.
 *
 * Recycle-safe: each ImageView is tagged with the URL it's currently loading, so
 * a slow response for a card that's since been rebound to another camera is
 * dropped instead of painting the wrong picture. Decoded bitmaps are memory-
 * cached by URL so re-focusing a card (hero reload) is instant.
 */
object ImageLoader {
    private val main = Handler(Looper.getMainLooper())
    private val tagKey = R.id.card_image   // any stable id; used as the "loading url" tag key

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build()
    }

    // ~1/8th of available heap for decoded snapshots.
    private val cache = object : LruCache<String, Bitmap>(
        (Runtime.getRuntime().maxMemory() / 1024 / 8).toInt()
    ) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount / 1024
    }

    /**
     * Load [url] (with bearer [token]) into [view]. Shows [placeholder] until the
     * image arrives; on failure the placeholder stays. Safe to call on rebind.
     */
    fun load(view: ImageView, url: String, token: String, placeholder: Int) {
        view.setTag(tagKey, url)
        cache.get(url)?.let { view.setImageBitmap(it); return }
        view.setImageResource(placeholder)
        val req = Request.Builder().url(url).addHeader("Authorization", "Bearer $token").build()
        Thread {
            var bmp: Bitmap? = null
            try {
                http.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val bytes = resp.body?.bytes()
                        if (bytes != null && bytes.isNotEmpty()) bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    }
                }
            } catch (_: Exception) { /* leave placeholder */ }
            val out = bmp ?: return@Thread
            cache.put(url, out)
            main.post {
                // Only paint if this view is still waiting on THIS url.
                if (view.getTag(tagKey) == url) view.setImageBitmap(out)
            }
        }.start()
    }
}

package com.eufyview.tv

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/** A labelled horizontal strip of camera cards (e.g. a house, or "Recent activity"). */
class Row(val id: String, var title: String, val cameras: MutableList<Camera> = ArrayList())

/**
 * Horizontal adapter: the camera cards within one row. Cards load the small
 * (640) snapshot - the big master is reserved for the hero. Focus scales the
 * card up a touch (the clean "Netflix" feel) and tells the controller to retune
 * the hero to the focused camera.
 */
class CardAdapter(
    private val serverUrl: String,
    private val token: String,
    private val cameras: MutableList<Camera>,
    private val onClick: (Camera) -> Unit,
    private val onFocus: (Camera) -> Unit
) : RecyclerView.Adapter<CardAdapter.VH>() {

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val image: ImageView = v.findViewById(R.id.card_image)
        val title: TextView = v.findViewById(R.id.card_title)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.dash_card, parent, false)
        return VH(v)
    }

    override fun getItemCount() = cameras.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val cam = cameras[position]
        holder.title.text = cam.name

        ImageLoader.load(holder.image, "$serverUrl/snapshot/${cam.serial}.jpg?size=sm", token, R.drawable.card_placeholder)

        holder.itemView.setOnClickListener { onClick(cam) }
        holder.itemView.setOnFocusChangeListener { v, hasFocus ->
            val s = if (hasFocus) 1.08f else 1.0f
            v.animate().scaleX(s).scaleY(s).translationZ(if (hasFocus) 12f else 0f).setDuration(140).start()
            holder.title.isSelected = hasFocus   // marquee the name if it's long
            if (hasFocus) onFocus(cam)
        }
    }
}

/**
 * Vertical adapter: the list of rows. Each row is a header + a horizontal
 * RecyclerView of cards. Rows share one view pool so cards recycle across them.
 */
class RowAdapter(
    private val serverUrl: String,
    private val token: String,
    private val rows: List<Row>,
    private val onClick: (Camera) -> Unit,
    private val onFocus: (Camera) -> Unit
) : RecyclerView.Adapter<RowAdapter.VH>() {

    private val pool = RecyclerView.RecycledViewPool()

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val title: TextView = v.findViewById(R.id.row_title)
        val cards: RecyclerView = v.findViewById(R.id.row_cards)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.dash_row, parent, false)
        val vh = VH(v)
        vh.cards.layoutManager = LinearLayoutManager(parent.context, LinearLayoutManager.HORIZONTAL, false)
        vh.cards.setRecycledViewPool(pool)
        return vh
    }

    override fun getItemCount() = rows.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val row = rows[position]
        holder.title.text = row.title
        holder.cards.adapter = CardAdapter(serverUrl, token, row.cameras, onClick, onFocus)
    }
}

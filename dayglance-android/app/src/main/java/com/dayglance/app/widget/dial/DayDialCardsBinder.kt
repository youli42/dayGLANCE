package com.dayglance.app.widget.dial

import android.content.res.Resources
import android.graphics.Color
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import com.dayglance.app.R

/**
 * Fills the All Day card and the legend in the tall and wide layouts
 * (widget_day_dial_tall.xml, widget_day_dial_wide.xml) from [DialCards], in
 * the in-app dial's tones: an incomplete all-day item at white 90 %, a done
 * one at 40 %, each with its muted colour dot.
 *
 * It only ever touches ids the arrangement's layout carries: the tall row
 * has three chips, the wide list five, the dial-only layout none. A
 * RemoteViews action on a view that is not there fails the whole widget.
 */
internal object DayDialCardsBinder {
    private class Chip(val row: Int, val dot: Int, val title: Int)

    private val CHIPS = listOf(
        Chip(R.id.ll_day_dial_allday_chip_1, R.id.iv_day_dial_allday_dot_1, R.id.tv_day_dial_allday_title_1),
        Chip(R.id.ll_day_dial_allday_chip_2, R.id.iv_day_dial_allday_dot_2, R.id.tv_day_dial_allday_title_2),
        Chip(R.id.ll_day_dial_allday_chip_3, R.id.iv_day_dial_allday_dot_3, R.id.tv_day_dial_allday_title_3),
        Chip(R.id.ll_day_dial_allday_chip_4, R.id.iv_day_dial_allday_dot_4, R.id.tv_day_dial_allday_title_4),
        Chip(R.id.ll_day_dial_allday_chip_5, R.id.iv_day_dial_allday_dot_5, R.id.tv_day_dial_allday_title_5),
    )

    private val LEGEND = mapOf(
        DialLegendKey.EFFORT to (R.id.ll_day_dial_legend_effort to R.id.tv_day_dial_legend_effort_value),
        DialLegendKey.RESTORE to (R.id.ll_day_dial_legend_restore to R.id.tv_day_dial_legend_restore_value),
        DialLegendKey.SLEEP to (R.id.ll_day_dial_legend_sleep to R.id.tv_day_dial_legend_sleep_value),
        DialLegendKey.UNBLOCKED to (R.id.ll_day_dial_legend_unblocked to R.id.tv_day_dial_legend_unblocked_value),
        DialLegendKey.ROUTINES to (R.id.ll_day_dial_legend_routines to R.id.tv_day_dial_legend_routines_value),
        DialLegendKey.FRAMES to (R.id.ll_day_dial_legend_frames to R.id.tv_day_dial_legend_frames_value),
    )

    // Lazy: this object also loads in JVM unit tests (legendValue is pure), where
    // android.graphics.Color is an unmocked stub that throws, and an eager
    // Color.argb here failed the whole object's initializer.
    private val TEXT_ON by lazy { Color.argb((0.90 * 255).toInt(), 255, 255, 255) }
    private val TEXT_DONE by lazy { Color.argb((0.40 * 255).toInt(), 255, 255, 255) }

    /** How many chips a placement's layout carries. */
    fun chipsIn(placement: DialPlacement): Int = when (placement) {
        DialPlacement.DIAL -> 0
        DialPlacement.TALL -> DialArrangement.MAX_TALL_CHIPS
        DialPlacement.WIDE -> DialArrangement.MAX_WIDE_ROWS
    }

    fun bind(views: RemoteViews, arrangement: DialArrangement, cards: DialCards, copy: DialHubCopy, resources: Resources) {
        if (arrangement.placement == DialPlacement.DIAL) return
        size(views, arrangement, resources)

        val slots = if (arrangement.showAllDay) arrangement.allDayChips else 0
        val (shown, hidden) = DialArrangement.overflow(cards.allDay.size, slots)
        views.setViewVisibility(R.id.ll_day_dial_allday, if (shown > 0) View.VISIBLE else View.GONE)
        for ((i, chip) in CHIPS.take(chipsIn(arrangement.placement)).withIndex()) {
            val item = cards.allDay.getOrNull(i)
            if (i >= shown || item == null) {
                views.setViewVisibility(chip.row, View.GONE)
                continue
            }
            views.setViewVisibility(chip.row, View.VISIBLE)
            views.setTextViewText(chip.title, item.title)
            views.setTextColor(chip.title, if (item.completed) TEXT_DONE else TEXT_ON)
            views.setInt(chip.dot, "setColorFilter", runCatching { Color.parseColor(DialPalette.mute(item.colorHex)) }.getOrDefault(Color.WHITE))
            // Tall: the shown chips share the row (one title alone gets nearly
            // all of it). Wide: each row is the column's width already.
            if (arrangement.placement == DialPlacement.TALL) {
                val maxDp = DialArrangement.tallTitleMaxDp(arrangement.dialWidthDp, arrangement.scale, shown, hidden)
                views.setInt(chip.title, "setMaxWidth", px(maxDp, resources))
            }
        }
        if (hidden > 0) {
            views.setViewVisibility(R.id.tv_day_dial_allday_more, View.VISIBLE)
            views.setTextViewText(R.id.tv_day_dial_allday_more, "+$hidden")
        } else {
            views.setViewVisibility(R.id.tv_day_dial_allday_more, View.GONE)
        }

        val legend = arrangement.showLegend && cards.legend.isNotEmpty()
        views.setViewVisibility(R.id.ll_day_dial_legend, if (legend) View.VISIBLE else View.GONE)
        // The tall grid's second row (unblocked, routines); the wide list has none.
        if (arrangement.placement == DialPlacement.TALL) {
            views.setViewVisibility(R.id.ll_day_dial_legend_row2,
                if (DialArrangement.tallLegendSecondRow(cards)) View.VISIBLE else View.GONE)
        }
        for ((key, ids) in LEGEND) {
            val item = cards.legend.firstOrNull { it.key == key }
            // Frames holds the tall grid's third column when absent, as the
            // spacer it replaced did, so unblocked and routines keep their width.
            val absent = if (key == DialLegendKey.FRAMES && arrangement.placement == DialPlacement.TALL) View.INVISIBLE else View.GONE
            views.setViewVisibility(ids.first, if (item != null) View.VISIBLE else absent)
            if (item != null) views.setTextViewText(ids.second, legendValue(item, copy))
        }
    }

    private val LEGEND_ICONS = listOf(R.id.iv_day_dial_legend_effort_icon, R.id.iv_day_dial_legend_restore_icon,
        R.id.iv_day_dial_legend_sleep_icon, R.id.iv_day_dial_legend_unblocked_icon, R.id.iv_day_dial_legend_routines_icon,
        R.id.iv_day_dial_legend_frames_icon)
    private val LEGEND_LABELS = listOf(R.id.tv_day_dial_legend_effort_label, R.id.tv_day_dial_legend_restore_label,
        R.id.tv_day_dial_legend_sleep_label, R.id.tv_day_dial_legend_unblocked_label, R.id.tv_day_dial_legend_routines_label,
        R.id.tv_day_dial_legend_frames_label)

    /**
     * Draws the cards up by the arrangement's scale: type, icons, the card
     * and row heights and paddings, and the wide column. Android 12+ only
     * (setViewLayoutWidth/Height); DialArrangement.choose keeps the scale at 1
     * below that, where the layouts' own dp stand. Base sizes are the layouts'.
     */
    private fun size(views: RemoteViews, arrangement: DialArrangement, resources: Resources) {
        val s = arrangement.scale.toFloat()
        if (s == 1f || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val dp = TypedValue.COMPLEX_UNIT_DIP
        fun text(id: Int, sp: Float) = views.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, sp * s)
        fun square(id: Int, d: Float) { views.setViewLayoutWidth(id, d * s, dp); views.setViewLayoutHeight(id, d * s, dp) }
        fun pad(id: Int, l: Double, t: Double, r: Double, b: Double) =
            views.setViewPadding(id, px(l * s, resources), px(t * s, resources), px(r * s, resources), px(b * s, resources))
        val tall = arrangement.placement == DialPlacement.TALL

        text(R.id.tv_day_dial_allday_label, 12f)
        text(R.id.tv_day_dial_allday_more, 13f)
        square(R.id.iv_day_dial_allday_icon, 15f)
        for (chip in CHIPS.take(chipsIn(arrangement.placement))) {
            text(chip.title, 13f)
            square(chip.dot, 6f)
        }
        LEGEND_LABELS.forEach { text(it, 11f) }
        LEGEND.values.forEach { text(it.second, 13f) }
        LEGEND_ICONS.forEach { square(it, if (tall) 14f else 15f) }

        if (tall) {
            views.setViewLayoutHeight(R.id.ll_day_dial_allday, (DialArrangement.TALL_CARD_DP * s).toFloat(), dp)
            pad(R.id.ll_day_dial_allday, 16.0, 0.0, 12.0, 0.0)
            views.setViewLayoutHeight(R.id.ll_day_dial_legend_row1, (DialArrangement.TALL_LEGEND_ROW_DP * s).toFloat(), dp)
            views.setViewLayoutHeight(R.id.ll_day_dial_legend_row2, (DialArrangement.TALL_LEGEND_ROW_DP * s).toFloat(), dp)
            pad(R.id.ll_day_dial_legend, 16.0, 8.0, 8.0, 8.0)
        } else {
            views.setViewLayoutWidth(R.id.ll_day_dial_column, ((DialArrangement.WIDE_COLUMN_DP - 6) * s).toFloat(), dp)
            pad(R.id.ll_day_dial_allday, 12.0, 12.0, 12.0, 12.0)
            pad(R.id.ll_day_dial_legend, 14.0, 10.0, 10.0, 10.0)
            for ((row, _) in LEGEND.values) views.setViewLayoutHeight(row, (DialArrangement.WIDE_LEGEND_ROW_DP * s).toFloat(), dp)
        }
    }

    private fun px(dp: Double, resources: Resources): Int = (dp * resources.displayMetrics.density).toInt()

    /** "3h 20m", "2/3" for routines, or "45%" for frames, as the in-app legend reads. */
    fun legendValue(item: DialLegendItem, copy: DialHubCopy): String = when (item.key) {
        DialLegendKey.ROUTINES -> "${item.done}/${item.total}"
        DialLegendKey.FRAMES -> "${item.percent ?: 0}%"
        else -> copy.duration(item.minutes ?: 0.0)
    }
}

package app.helix.model

import java.time.Duration
import java.time.Instant
import kotlin.math.roundToLong

object RelativeTime {
    /** "now", "8m ago", "2h 14m ago", "6h ago", "yesterday", "3d ago". */
    fun short(from: Instant, to: Instant = Instant.now()): String {
        val seconds = maxOf(0L, Duration.between(from, to).seconds)
        val minutes = seconds / 60
        val hours = minutes / 60
        return when {
            seconds < 60 -> "now"
            seconds < 3_600 -> "${minutes}m ago"
            seconds < 3 * 3_600 -> { val r = minutes % 60; if (r == 0L) "${hours}h ago" else "${hours}h ${r}m ago" }
            seconds < 86_400 -> "${hours}h ago"
            seconds < 2 * 86_400 -> "yesterday"
            else -> "${hours / 24}d ago"
        }
    }
}

object DurationText {
    /** "1h 24m", "12m", "45s". Negative intervals read as "0m". */
    fun short(seconds: Double): String {
        val s = maxOf(0L, seconds.roundToLong())
        val hours = s / 3_600
        val minutes = (s % 3_600) / 60
        return when {
            hours > 0 -> "${hours}h ${minutes}m"
            minutes > 0 -> "${minutes}m"
            s > 0 -> "${s}s"
            else -> "0m"
        }
    }

    /** "4:12", "1:02:09" for call timers. */
    fun clock(seconds: Double): String {
        val s = maxOf(0L, seconds.toLong())
        val hours = s / 3_600
        val minutes = (s % 3_600) / 60
        val secs = s % 60
        return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, secs) else "%d:%02d".format(minutes, secs)
    }

    fun between(from: Instant, to: Instant): Double = Duration.between(from, to).toMillis() / 1000.0
}

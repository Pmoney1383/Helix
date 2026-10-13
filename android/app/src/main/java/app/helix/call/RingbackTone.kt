package app.helix.call

import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * The "brrring ... brrring" played after the user calls Helix, so the instant gateway answer still feels like dialling
 * someone. Two summed sines (440 + 480 Hz), 1.0 s on, 0.6 s off, cut to exactly `durationMs` with a short fade.
 * 16-bit mono PCM, little-endian.
 */
object RingbackTone {
    fun pcm(durationMs: Int, sampleRate: Int = 24_000): ShortArray {
        val total = (durationMs / 1000.0 * sampleRate).toInt()
        if (total <= 0) return ShortArray(0)
        val on = 1.0
        val period = 1.6
        val fade = 0.02
        return ShortArray(total) { i ->
            val t = i.toDouble() / sampleRate
            val phase = t % period
            val gain = if (phase < on) min(1.0, min(phase / fade, (on - phase) / fade)) else 0.0
            val tail = min(1.0, ((total - i).toDouble() / sampleRate) / fade)
            val tone = sin(2 * PI * 440 * t) + sin(2 * PI * 480 * t)
            (0.18 * gain * tail * tone * Short.MAX_VALUE).toInt().toShort()
        }
    }
}

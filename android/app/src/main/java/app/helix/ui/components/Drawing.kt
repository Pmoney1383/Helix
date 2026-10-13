package app.helix.ui.components

import android.graphics.BlurMaskFilter
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.nativeCanvas

// Drawing helpers for the hand-drawn artwork (hero card, call cards, Helix mark). SwiftUI's `.blur(radius:)` and the
// `.shadow` filter become a blur mask on the paint; `.plusLighter` is additive (`BlendMode.Plus`), `.screen` is screen.

/** Strokes or fills `path` with `brush`, blurred by `blur` px (0 = crisp). */
fun DrawScope.drawPathEx(
    path: Path,
    brush: Brush,
    strokeWidth: Float? = null,
    blur: Float = 0f,
    blend: BlendMode = BlendMode.SrcOver,
    alpha: Float = 1f,
    dash: FloatArray? = null,
) {
    if (blur <= 0f && dash == null) {
        if (strokeWidth != null) drawPath(path, brush, alpha = alpha, style = Stroke(strokeWidth), blendMode = blend)
        else drawPath(path, brush, alpha = alpha, blendMode = blend)
        return
    }
    drawIntoCanvas { canvas ->
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        when (brush) {
            is SolidColor -> paint.color = brush.value.toArgb()
            is ShaderBrush -> paint.shader = brush.createShader(Size(size.width, size.height))
            else -> {}
        }
        paint.alpha = (paint.alpha * alpha).toInt().coerceIn(0, 255)
        if (strokeWidth != null) {
            paint.style = android.graphics.Paint.Style.STROKE
            paint.strokeWidth = strokeWidth
            paint.strokeCap = android.graphics.Paint.Cap.ROUND
        }
        if (blur > 0f) paint.maskFilter = BlurMaskFilter(blur, BlurMaskFilter.Blur.NORMAL)
        if (dash != null) paint.pathEffect = android.graphics.DashPathEffect(dash, 0f)
        if (android.os.Build.VERSION.SDK_INT >= 29) paint.blendMode = when (blend) {
            BlendMode.Plus -> android.graphics.BlendMode.PLUS
            BlendMode.Screen -> android.graphics.BlendMode.SCREEN
            else -> android.graphics.BlendMode.SRC_OVER
        }
        canvas.nativeCanvas.drawPath(path.asAndroidPath(), paint)
    }
}

/** An ellipse path. */
fun ellipse(center: Offset, rx: Float, ry: Float): Path = Path().apply {
    addOval(androidx.compose.ui.geometry.Rect(center.x - rx, center.y - ry, center.x + rx, center.y + ry))
}

fun circle(center: Offset, r: Float) = ellipse(center, r, r)

/** A radial fill like SwiftUI's `.radialGradient(…, startRadius: 0, endRadius: r)` inside a circle. */
fun DrawScope.radialSpot(center: Offset, radius: Float, colors: List<Pair<Float, Color>>, blend: BlendMode = BlendMode.SrcOver, scaleX: Float = 1f, scaleY: Float = 1f) {
    if (radius <= 0f) return
    val brush = Brush.radialGradient(*colors.toTypedArray(), center = Offset.Zero, radius = radius)
    val canvas = drawContext.canvas
    canvas.save()
    canvas.translate(center.x, center.y)
    canvas.scale(scaleX, scaleY)
    drawCircle(brush, radius, Offset.Zero, blendMode = blend)
    canvas.restore()
}

/**
 * SwiftUI's `EllipticalGradient` over the whole area: the gradient's unit circle is stretched to the ellipse `rx` x `ry`
 * around `center`, and everything outside it keeps the last colour.
 */
fun DrawScope.ellipticalGradient(center: Offset, rx: Float, ry: Float, stops: List<Pair<Float, Color>>, blend: BlendMode = BlendMode.SrcOver) {
    if (rx <= 0f || ry <= 0f) return
    val w = size.width
    val h = size.height
    val brush = Brush.radialGradient(*stops.toTypedArray(), center = Offset.Zero, radius = 1f)
    val canvas = drawContext.canvas
    canvas.save()
    canvas.translate(center.x, center.y)
    canvas.scale(rx, ry)
    drawRect(brush, topLeft = Offset(-center.x / rx, -center.y / ry), size = Size(w / rx, h / ry), blendMode = blend)
    canvas.restore()
}

/** SplitMix64, so the dust and terrain land in the same places on every render (as on the iPhone). */
class SeededRandom(seed: Long) {
    private var state = seed
    fun next(): Long {
        state += -0x61c8864680b583ebL
        var z = state
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }

    /** A double in [0, 1). */
    fun unit(): Double = (next() ushr 11).toDouble() / (1L shl 53).toDouble()
    fun range(a: Double, b: Double) = a + (b - a) * unit()
    fun bool() = (next() ushr 17) and 1L == 0L
}

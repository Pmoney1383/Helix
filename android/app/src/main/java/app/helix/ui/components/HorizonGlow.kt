package app.helix.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.EaseInOut
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * The hero card's artwork (the iPhone's HorizonGlow.swift): a textured planet with a gold sunrise on its rim, light haze
 * climbing the right edge and gold dust, composited from the same layers in the same order.
 */
@Composable
fun HorizonGlow(modifier: Modifier = Modifier, horizon: Float = 0.74f) {
    val breathe by rememberInfiniteTransition(label = "breathe").animateFloat(
        0.8f, 1f, infiniteRepeatable(tween(4000, easing = EaseInOut), RepeatMode.Reverse), label = "bloom",
    )
    Canvas(modifier.graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
        val g = HorizonGeometry(size.width, size.height, horizon)
        val dp = density
        heroBase()
        heroAmbient(g)
        goldDust(g, dp)
        atmosphere(g, dp)
        planet(g, dp)
        rimLight(g, dp)
        lightRays(g, dp)
        heroGlass()
        sunriseBloom(g, dp, breathe)
    }
}

/** The planet: a circle whose top touches the horizon and whose rim meets the bottom corners. */
private class HorizonGeometry(val width: Float, val height: Float, horizon: Float) {
    val horizonY = height * horizon
    val radius = width * 0.78f
    val center = Offset(width * 0.5f, horizonY + radius)
    /** The sunrise sits a little right of center, like the light source in the mockup. */
    val sun = Offset(width * 0.58f, rimY(width * 0.58f))
    val planet: Path = circle(center, radius)

    fun rimY(x: Float): Float {
        val dx = x - center.x
        return center.y - sqrt(max(radius * radius - dx * dx, 0f))
    }

    /** Brightest just right of center, still glowing where the rim meets the card edges. */
    fun rimShading(color: Color, peak: Float) = Brush.horizontalGradient(
        0f to color.copy(alpha = peak * 0.55f), 0.24f to color.copy(alpha = peak * 0.42f), 0.47f to color.copy(alpha = peak * 0.85f),
        0.6f to color.copy(alpha = peak), 0.8f to color.copy(alpha = peak * 0.75f), 1f to color.copy(alpha = peak * 0.65f),
        startX = 0f, endX = width,
    )
}

/** Near-black glass, a touch lighter in the upper left. */
private fun DrawScope.heroBase() {
    drawRect(Brush.linearGradient(0f to Color(0xFF1C1915), 0.45f to Color(0xFF13110E), 1f to Color(0xFF0B0A08), start = Offset.Zero, end = Offset(size.width, size.height)))
}

/** Warm haze climbing the right edge, a faint top-right bloom and warmth above the horizon. */
private fun DrawScope.heroAmbient(g: HorizonGeometry) {
    data class Spot(val c: Offset, val r: Float, val sx: Float, val sy: Float, val color: Color, val a: Float)
    listOf(
        Spot(Offset(g.width * 1.02f, g.height * 0.66f), g.height * 0.6f, 0.7f, 1.35f, Color(0xFFD08C30), 0.46f),
        Spot(Offset(g.width * 0.92f, 0f), g.height * 0.45f, 1.6f, 1f, Color(0xFFB98236), 0.12f),
        Spot(Offset(g.sun.x, g.horizonY), g.width * 0.62f, 1f, 0.42f, Color(0xFFB97A2C), 0.26f),
        Spot(Offset(0f, g.height), g.height * 0.4f, 1.2f, 1f, Color(0xFFC8862E), 0.2f),
    ).forEach { radialSpot(it.c, it.r, listOf(0f to it.color.copy(alpha = it.a), 1f to it.color.copy(alpha = 0f)), BlendMode.Screen, it.sx, it.sy) }
}

/** Gold dust, denser and brighter toward the lit right side; a few motes carry a soft glow. */
private fun DrawScope.goldDust(g: HorizonGeometry, dp: Float) {
    val random = SeededRandom(7)
    val glowing = mutableListOf<Pair<Rect, Float>>()
    for (index in 0 until 320) {
        val skew = random.unit().pow(1.7)
        val x = (g.width * (1 - skew * 0.97)).toFloat()
        val y = random.range(0.0, (g.horizonY / dp + 6).toDouble()).toFloat() * dp
        val side = x / g.width
        val radius = (random.range(0.25, 0.75) * (0.7 + 0.45 * side)).toFloat() * dp
        val alpha = (random.range(0.06, 0.32) + 0.4 * side * side).toFloat()
        val rect = Rect(x - radius, y - radius, x + radius, y + radius)
        if (index % 24 == 0 && side > 0.55f) {
            glowing += rect.inflate(0.4f * dp) to (alpha + 0.2f).coerceAtMost(1f)
        } else {
            drawOval(Color(0xFFFFD27A).copy(alpha = alpha.coerceAtMost(0.85f)), rect.topLeft, rect.size, blendMode = BlendMode.Plus)
        }
    }
    for ((rect, alpha) in glowing) {
        val path = Path().apply { addOval(rect) }
        drawPathEx(path, SolidColor(Color(0xFFFFC35C).copy(alpha = 0.9f)), blur = 3 * dp, blend = BlendMode.Plus)
        drawOval(Color(0xFFFFF0C8).copy(alpha = alpha), rect.topLeft, rect.size, blendMode = BlendMode.Plus)
    }
}

/** Wide glow above the rim; the planet drawn next hides its inner half. */
private fun DrawScope.atmosphere(g: HorizonGeometry, dp: Float) {
    drawPathEx(g.planet, g.rimShading(Color(0xFFD68926), 0.55f), strokeWidth = 70 * dp, blur = 30 * dp, blend = BlendMode.Plus)
    drawPathEx(g.planet, g.rimShading(Color(0xFFF4A735), 0.5f), strokeWidth = 22 * dp, blur = 12 * dp, blend = BlendMode.Plus)
}

/** The planet body: lit from the sunrise, with soft terrain, fine grain and light scattering just inside the limb. */
private fun DrawScope.planet(g: HorizonGeometry, dp: Float) {
    drawPath(g.planet, Brush.radialGradient(
        0f to Color(0xFF5E411D), 0.16f to Color(0xFF352510), 0.48f to Color(0xFF17110A), 1f to Color(0xFF080604),
        center = g.sun, radius = g.width * 0.95f,
    ))
    clipPath(g.planet) {
        val random = SeededRandom(21)
        for (i in 0 until 160) {
            val x = random.range(0.0, (size.width / dp).toDouble()).toFloat() * dp
            val y = random.range((g.horizonY / dp - 6).toDouble(), (size.height / dp).toDouble()).toFloat() * dp
            val rx = random.range(3.0, 18.0).toFloat() * dp
            val ry = rx * random.range(0.25, 0.45).toFloat()
            val lit = random.bool()
            val alpha = random.range(0.04, 0.1).toFloat()
            drawPathEx(ellipse(Offset(x, y), rx, ry), SolidColor((if (lit) Color(0xFFB9813F) else Color.Black).copy(alpha = alpha)), blur = 1.6f * dp)
        }
        for (i in 0 until 520) {
            val x = random.range(0.0, (size.width / dp).toDouble()).toFloat() * dp
            val y = random.range((g.horizonY / dp - 4).toDouble(), (size.height / dp).toDouble()).toFloat() * dp
            val r = random.range(0.35, 0.8).toFloat() * dp
            val lit = random.bool()
            val alpha = random.range(0.05, 0.16).toFloat()
            drawCircle((if (lit) Color(0xFFE2B678) else Color.Black).copy(alpha = alpha), r, Offset(x, y))
        }
        drawPathEx(g.planet, g.rimShading(Color(0xFFE09A3A), 0.6f), strokeWidth = 24 * dp, blur = 10 * dp)
        drawRect(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.4f)), startY = g.horizonY + 10 * dp, endY = size.height))
    }
}

/** The lit limb: a wide bloom, a gold glow and a hot hairline. */
private fun DrawScope.rimLight(g: HorizonGeometry, dp: Float) {
    drawPathEx(g.planet, g.rimShading(Color(0xFFF4A735), 0.85f), strokeWidth = 7 * dp, blur = 5 * dp, blend = BlendMode.Plus)
    drawPathEx(g.planet, g.rimShading(Color(0xFFFFD77C), 0.95f), strokeWidth = 2.4f * dp, blur = 1.4f * dp, blend = BlendMode.Plus)
    drawPathEx(g.planet, g.rimShading(Color(0xFFFFF3D6), 1f), strokeWidth = 0.9f * dp, blend = BlendMode.Plus)
}

/** Faint light streaks rising from the right side of the horizon toward the upper right. */
private fun DrawScope.lightRays(g: HorizonGeometry, dp: Float) {
    listOf(
        floatArrayOf(0.76f, 0.42f, 0.55f, 0.12f), floatArrayOf(0.84f, 0.6f, 0.66f, 0.2f),
        floatArrayOf(0.9f, 0.46f, 0.6f, 0.15f), floatArrayOf(0.96f, 0.62f, 0.72f, 0.22f),
    ).forEach { (rx, length, slant, opacity) ->
        val x = g.width * rx
        val start = Offset(x, g.rimY(x) - 2 * dp)
        val l = g.height * length
        val end = Offset(start.x + l * slant, start.y - l * 0.8f)
        val path = Path().apply { moveTo(start.x, start.y); lineTo(end.x, end.y) }
        val shading = Brush.linearGradient(listOf(Color(0xFFFFCF7A).copy(alpha = opacity), Color(0xFFFFCF7A).copy(alpha = 0f)), start, end)
        drawPathEx(path, shading, strokeWidth = 10 * dp, blur = 7 * dp, blend = BlendMode.Plus)
        drawPathEx(path, shading, strokeWidth = 1.2f * dp, blur = 1.5f * dp, blend = BlendMode.Plus)
    }
}

/** Top sheen and a vignette that keeps the upper left (behind the text) the darkest. */
private fun DrawScope.heroGlass() {
    drawRect(Brush.verticalGradient(0f to Color.White.copy(alpha = 0.04f), 0.3f to Color.Transparent))
    ellipticalGradient(
        Offset(size.width * 0.7f, size.height * 0.75f), size.width / 2, size.height / 2,
        listOf(0f to Color.Transparent, 0.35f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.3f)),
    )
}

/** The hot spot where the sun breaks over the rim. */
private fun DrawScope.sunriseBloom(g: HorizonGeometry, dp: Float, opacity: Float) {
    val sun = g.sun
    val rx = g.width * 0.3f
    val ry = 16 * dp
    drawPathEx(
        ellipse(sun, rx, ry),
        Brush.radialGradient(listOf(Color(0xFFFFE7B0).copy(alpha = 0.42f * opacity), Color(0xFFF4A735).copy(alpha = 0.2f * opacity), Color.Transparent), center = sun, radius = rx),
        blur = 12 * dp, blend = BlendMode.Plus,
    )
    drawPathEx(ellipse(sun, g.width * 0.13f, 4 * dp), SolidColor(Color(0xFFFFF6E2).copy(alpha = 0.75f * opacity)), blur = 4 * dp, blend = BlendMode.Plus)
}

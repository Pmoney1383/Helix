package app.helix.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.helix.model.FrontDoor
import app.helix.model.Logo
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.semibold
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Visual recipe for one assistant's call card: dark smoked glass lit by gold, never filled with it. */
class AssistantCardTheme(
    val claude: Boolean,
    val background: List<Pair<Float, Color>>,
    /** Peak opacity of the glow behind the icon. */
    val iconGlow: Float,
    /** Strength multiplier for the background blooms. */
    val ambient: Float,
    /** Strength multiplier for the lower energy sweep. */
    val sweep: Float,
) {
    companion object {
        val Claude = AssistantCardTheme(true, listOf(0f to Color(0xFF2B261E), 0.2f to Color(0xFF24201A), 0.58f to Color(0xFF1C1B19), 1f to Color(0xFF121313)), 0.3f, 1f, 1f)
        val Astra = AssistantCardTheme(false, listOf(0f to Color(0xFF25211C), 0.2f to Color(0xFF1D1B18), 0.58f to Color(0xFF151515), 1f to Color(0xFF0E0F10)), 0.23f, 0.8f, 0.95f)
        fun of(door: FrontDoor) = if (door == FrontDoor.Claude) Claude else Astra

        val radius = 26.dp
        val gold = Color(0xFFD99B38)
        val goldBright = Color(0xFFFFD77C)
        val line = Color(0xFFD4942C)
        val spark = Color(0xFFFFF0C8)
        val glowCore = Color(0xFFFFB747)
        val glowMid = Color(0xFFDA9129)
        val title = Color(0xFFF7F3EA)
        val subtitle = Color(0xFFA99F8E)
        val chevron = Color(0xFFFFE0A0)

        fun border(w: Float, h: Float) = Brush.linearGradient(
            0f to Color(0xFF8A571C), 0.38f to Color(0xFFD99B38), 0.72f to Color(0xFFFFD77C), 0.86f to Color(0xFFFFE3A3), 1f to Color(0xFFA96820),
            start = Offset(0f, h), end = Offset(w, 0f),
        )
    }
}

/** The Call Claude / Call Astra cards on Home and Calls. */
@Composable
fun AssistantCallCard(door: FrontDoor, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = AssistantCardTheme.of(door)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.985f else 1f, tween(150), label = "cardPress")
    val iconSlot = scaled(32.dp)
    val logoSize = scaled(26.dp)
    val chevronSize = scaled(32.dp)
    val padding = 12.dp
    val density = LocalDensity.current
    val anchorX = with(density) { (padding + iconSlot / 2).toPx() }
    val haloR = with(density) { (iconSlot / 2 + 11.dp).toPx() }
    val shape = RoundedCornerShape(AssistantCardTheme.radius)

    Box(
        modifier
            .fillMaxHeight()
            .defaultMinSize(minHeight = 84.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .shadow(12.dp, shape, ambientColor = Color.Black.copy(alpha = 0.35f), spotColor = AssistantCardTheme.gold.copy(alpha = if (pressed) 0.16f else 0.1f))
            .clip(shape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
    ) {
        Canvas(Modifier.matchParentSize().graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
            cardSurface(theme, anchorX, haloR, if (pressed) 1.35f else 1f, pressed)
        }
        val titleStyle = HelixType.subheadline.semibold.copy(shadow = textGlow(Color.Black.copy(alpha = 0.55f), 8f))
        val subtitleStyle = HelixType.caption.copy(shadow = textGlow(Color.Black.copy(alpha = 0.55f), 8f))
        val measurer = rememberTextMeasurer()
        var cardWidth by remember { mutableIntStateOf(0) }
        Box(Modifier.fillMaxWidth().onSizeChanged { cardWidth = it.width }) {
            // ViewThatFits: with the chevron when the text fits beside it on one line, otherwise without it and wrapped.
            val room = with(density) { cardWidth.toDp() } - padding * 2 - iconSlot - chevronSize - 20.dp
            val needed = with(density) {
                maxOf(measurer.measure(door.callTitle, titleStyle).size.width, measurer.measure(door.callSubtitle, subtitleStyle).size.width).toDp()
            }
            val showsChevron = cardWidth == 0 || needed <= room
            Row(
                Modifier.fillMaxWidth().padding(horizontal = padding, vertical = Spacing.md).defaultMinSize(minHeight = 60.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(iconSlot), contentAlignment = Alignment.Center) {
                    BrandLogo(door.logo, logoSize, glow = if (theme.claude) 0.5f else 0.4f)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(door.callTitle, style = titleStyle, color = AssistantCardTheme.title, maxLines = if (showsChevron) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                    Text(door.callSubtitle, style = subtitleStyle, color = AssistantCardTheme.subtitle, maxLines = if (showsChevron) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                }
                if (showsChevron) ChevronOrb(chevronSize)
            }
        }
        Canvas(Modifier.matchParentSize()) {
            illuminatedBorder(
                AssistantCardTheme.radius.toPx(), AssistantCardTheme.border(size.width, size.height),
                outerBlur = 9f, outerAlpha = if (pressed) 0.72f else 0.55f, rimAlpha = if (pressed) 0.85f else 0.65f,
                innerWidth = 9f, innerBlur = 6f, innerAlpha = if (pressed) 0.26f else 0.15f, strokeWidth = if (pressed) 1.4f else 1.15f,
                specular = 0.5f, specularStop = 0.3f, hairline = 0.08f, hairlineBottom = 0.02f,
            )
        }
    }
}

// MARK: - Geometry

/** One orbit stroke: a sweeping cubic curve or a (possibly partial) tilted ellipse. */
private class OrbitPass(val kind: Kind, val opacity: Float, val width: Float) {
    sealed interface Kind {
        class Curve(val p0: Offset, val c1: Offset, val c2: Offset, val p1: Offset) : Kind
        class Ellipse(val center: Offset, val rx: Float, val ry: Float, val tilt: Float, val from: Float, val to: Float) : Kind
    }

    fun point(t: Float): Offset = when (val k = kind) {
        is Kind.Curve -> {
            val mt = 1 - t
            val a = mt * mt * mt; val b = 3 * mt * mt * t; val c = 3 * mt * t * t; val d = t * t * t
            Offset(a * k.p0.x + b * k.c1.x + c * k.c2.x + d * k.p1.x, a * k.p0.y + b * k.c1.y + c * k.c2.y + d * k.p1.y)
        }
        is Kind.Ellipse -> {
            val angle = k.from + (k.to - k.from) * t
            val x = k.rx * cos(angle); val y = k.ry * sin(angle)
            Offset(k.center.x + x * cos(k.tilt) - y * sin(k.tilt), k.center.y + x * sin(k.tilt) + y * cos(k.tilt))
        }
    }

    val isClosed: Boolean get() = (kind as? Kind.Ellipse)?.let { it.to - it.from >= 2 * PI.toFloat() - 0.001f } ?: false

    val path: Path get() = Path().apply {
        when (val k = kind) {
            is Kind.Curve -> { moveTo(k.p0.x, k.p0.y); cubicTo(k.c1.x, k.c1.y, k.c2.x, k.c2.y, k.p1.x, k.p1.y) }
            is Kind.Ellipse -> { val p = point(0f); moveTo(p.x, p.y); for (s in 1..96) { val q = point(s / 96f); lineTo(q.x, q.y) } }
        }
    }

    /** Gradient axis: end to end for open strokes, left to right for closed orbits. */
    val axis: Pair<Offset, Offset> get() {
        val k = kind
        if (k is Kind.Ellipse && isClosed) return Offset(k.center.x - k.rx, k.center.y) to Offset(k.center.x + k.rx, k.center.y)
        return point(0f) to point(1f)
    }

    /** Fades open strokes in and out so they read as light trails rather than drawn lines. */
    fun shading(color: Color, opacity: Float): Brush {
        val stops = if (isClosed) arrayOf(0f to color.copy(alpha = opacity * 0.3f), 0.62f to color.copy(alpha = opacity), 1f to color.copy(alpha = opacity * 0.45f))
        else arrayOf(0f to color.copy(alpha = 0f), 0.22f to color.copy(alpha = opacity * 0.7f), 0.6f to color.copy(alpha = opacity), 1f to color.copy(alpha = 0f))
        return Brush.linearGradient(*stops, start = axis.first, end = axis.second)
    }
}

private class GlowNode(val point: Offset, val radius: Float, val intensity: Float)

/** Shared layout for the orbit, sweep, node and spark layers so the nodes land on the lines. Units are px; `d` is the density. */
private class CardGeometry(val w: Float, val h: Float, anchorX: Float, val halo: Float, val claude: Boolean, val d: Float) {
    val icon = Offset(anchorX, h / 2)
    private val pi = PI.toFloat()

    val orbits: List<OrbitPass> = if (claude) listOf(
        OrbitPass(OrbitPass.Kind.Curve(Offset(-6 * d, h * 0.8f), Offset(w * 0.36f, h * 0.6f), Offset(w * 0.7f, h * 0.5f), Offset(w + 6 * d, h * 0.04f)), 0.2f, 0.6f),
        OrbitPass(OrbitPass.Kind.Ellipse(icon, halo + 15 * d, halo + 11 * d, 0f, -0.4f * pi, 0.42f * pi), 0.16f, 0.5f),
        OrbitPass(OrbitPass.Kind.Curve(Offset(w * 0.16f, h + 3 * d), Offset(w * 0.45f, h * 0.99f), Offset(w * 0.8f, h * 0.86f), Offset(w + 4 * d, h * 0.6f)), 0.16f, 0.5f),
        OrbitPass(OrbitPass.Kind.Curve(Offset(icon.x + halo * 0.6f, -3 * d), Offset(w * 0.5f, h * 0.12f), Offset(w * 0.82f, h * 0.32f), Offset(w + 4 * d, h * 0.8f)), 0.1f, 0.5f),
    ) else {
        val oc = Offset(icon.x + w * 0.25f, icon.y + h * 0.2f)
        listOf(
            OrbitPass(OrbitPass.Kind.Ellipse(oc, w * 0.6f, h * 0.42f, -0.12f, 0f, 2 * pi), 0.24f, 0.7f),
            OrbitPass(OrbitPass.Kind.Ellipse(oc, w * 0.88f, h * 0.72f, -0.07f, 0.95f * pi, 2.15f * pi), 0.15f, 0.5f),
            OrbitPass(OrbitPass.Kind.Curve(Offset(-4 * d, h * 0.22f), Offset(w * 0.3f, h * 0.04f), Offset(w * 0.66f, -h * 0.02f), Offset(w + 4 * d, h * 0.16f)), 0.1f, 0.5f),
            OrbitPass(OrbitPass.Kind.Ellipse(Offset(w * 0.86f, h * 0.24f), 28 * d, 10 * d, 0.3f, 0.15f * pi, 1.25f * pi), 0.16f, 0.5f),
            OrbitPass(OrbitPass.Kind.Curve(Offset(w * 0.08f, h + 2 * d), Offset(w * 0.4f, h * 0.88f), Offset(w * 0.74f, h * 0.92f), Offset(w + 4 * d, h * 0.7f)), 0.12f, 0.5f),
        )
    }

    val sweep: OrbitPass = if (claude)
        OrbitPass(OrbitPass.Kind.Curve(Offset(icon.x - 18 * d, h * 0.98f), Offset(w * 0.32f, h * 0.99f), Offset(w * 0.68f, h * 0.8f), Offset(w + 8 * d, h * 0.32f)), 1f, 0.8f)
    else OrbitPass(OrbitPass.Kind.Curve(Offset(icon.x - 10 * d, h * 1.01f), Offset(w * 0.38f, h * 1.03f), Offset(w * 0.72f, h * 0.86f), Offset(w + 8 * d, h * 0.44f)), 1f, 0.8f)

    fun onHalo(angle: Float, inset: Float = 0f) = Offset(icon.x + (halo + inset) * cos(angle), icon.y + (halo + inset) * sin(angle))

    val nodes: List<GlowNode> get() = if (claude) listOf(
        GlowNode(sweep.point(0.6f), 2.1f, 1f), GlowNode(orbits[0].point(0.86f), 1.6f, 0.75f),
        GlowNode(onHalo(-0.3f * pi), 1.6f, 0.85f), GlowNode(orbits[2].point(0.3f), 1.3f, 0.55f),
    ) else listOf(
        GlowNode(onHalo(-0.28f * pi), 1.9f, 0.95f), GlowNode(orbits[0].point(0.16f), 1.8f, 0.9f),
        GlowNode(orbits[1].point(0.62f), 1.4f, 0.65f), GlowNode(orbits[3].point(0.55f), 1.3f, 0.7f), GlowNode(onHalo(0.72f * pi), 1.2f, 0.55f),
    )
}

// MARK: - Layers

private fun DrawScope.cardSurface(theme: AssistantCardTheme, anchorX: Float, haloR: Float, boost: Float, pressed: Boolean) {
    val d = density
    val w = size.width
    val h = size.height
    val g = CardGeometry(w, h, anchorX, haloR, theme.claude, d)

    // 1. Charcoal base: a warm multi-stop diagonal gradient, darkened toward the bottom.
    drawRect(Color.Black)
    drawRect(Brush.linearGradient(*theme.background.toTypedArray(), start = Offset.Zero, end = Offset(w, h)))
    drawRect(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.18f)), startY = h / 2, endY = h))

    // 2. Localized warm blooms, so the card is lit unevenly like light falling across glass.
    val spots = if (theme.claude) listOf(
        Triple(g.icon, h * 0.7f, 1.2f) to (Color(0xFFC98A35) to 0.1f * boost),
        Triple(Offset(w * 0.62f, h * 1.02f), h * 0.75f, 2.3f) to (Color(0xFFB07A30) to 0.12f),
        Triple(Offset(w * 0.94f, 0f), h * 0.6f, 1.7f) to (Color(0xFFD9A050) to 0.09f),
    ) else listOf(
        Triple(g.icon, h * 0.65f, 1.2f) to (Color(0xFFC48836) to 0.08f * boost),
        Triple(Offset(w * 0.74f, h * 0.95f), h * 0.7f, 2.2f) to (Color(0xFFA8752F) to 0.09f),
        Triple(Offset(w * 0.42f, h * 0.02f), h * 0.55f, 2.4f) to (Color(0xFF8C7A60) to 0.07f),
    )
    for ((geo, look) in spots) {
        val (c, r, stretch) = geo
        val (color, a) = look
        radialSpot(c, r, listOf(0f to color.copy(alpha = a * theme.ambient), 1f to color.copy(alpha = 0f)), BlendMode.Screen, stretch, 1f)
    }

    // 3. Glass depth: top sheen, darker floor, a diagonal reflection and a soft vignette.
    drawRect(Brush.verticalGradient(0f to Color.White.copy(alpha = 0.035f), 0.38f to Color.Transparent, 0.62f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.22f)))
    drawRect(Brush.linearGradient(0.22f to Color.Transparent, 0.4f to Color.White.copy(alpha = 0.035f), 0.54f to Color.Transparent, start = Offset.Zero, end = Offset(w, h)), blendMode = BlendMode.Screen)
    ellipticalGradient(center, w / 2, h / 2, listOf(0f to Color.Transparent, 0.42f to Color.Transparent, 0.75f to Color.Black.copy(alpha = 0.26f), 1f to Color.Black.copy(alpha = 0.26f)))

    // 4. Faint orbit passes, each with a soft glow beneath a crisp hairline.
    for (orbit in g.orbits) {
        val path = orbit.path
        drawPathEx(path, orbit.shading(AssistantCardTheme.line, orbit.opacity * 0.6f), strokeWidth = orbit.width * 3 * d, blur = 2 * d, blend = BlendMode.Plus)
        drawPathEx(path, orbit.shading(AssistantCardTheme.goldBright, orbit.opacity), strokeWidth = orbit.width * d, blend = BlendMode.Plus)
    }

    // 6. The bright energy arc across the lower third: wide bloom, mid glow, hot core.
    val sweep = g.sweep
    val sweepPath = sweep.path
    val strength = theme.sweep * boost
    fun sweepShading(color: Color, o: Float) = Brush.linearGradient(
        0f to color.copy(alpha = 0f), 0.2f to color.copy(alpha = o * 0.3f), 0.6f to color.copy(alpha = o), 0.85f to color.copy(alpha = o * 0.5f), 1f to color.copy(alpha = 0f),
        start = sweep.axis.first, end = sweep.axis.second,
    )
    drawPathEx(sweepPath, sweepShading(AssistantCardTheme.gold, 0.5f * strength), strokeWidth = 7 * d, blur = 7 * d, blend = BlendMode.Plus)
    drawPathEx(sweepPath, sweepShading(AssistantCardTheme.goldBright, 0.65f * strength), strokeWidth = 1.8f * d, blur = 1.6f * d, blend = BlendMode.Plus)
    drawPathEx(sweepPath, sweepShading(AssistantCardTheme.spark, 0.9f * strength), strokeWidth = 0.7f * d, blend = BlendMode.Plus)

    // 7. The icon halo.
    if (theme.claude) claudeHalo(g.icon, haloR, theme.iconGlow * boost, d) else astraHalo(g.icon, haloR, theme.iconGlow * boost, d)

    // 5. Nodes riding the orbits: a soft halo, bloom and a hot core; the brightest gets a flare.
    for (node in g.nodes) {
        val r = node.radius * d
        radialSpot(node.point, r * 5, listOf(0f to AssistantCardTheme.glowCore.copy(alpha = 0.5f * node.intensity), 1f to AssistantCardTheme.glowCore.copy(alpha = 0f)), BlendMode.Plus)
        if (node.intensity >= 0.95f) {
            val flare = r * 7
            for ((dx, dy) in listOf(flare to 0f, 0f to flare * 0.6f)) {
                val a = Offset(node.point.x - dx, node.point.y - dy)
                val b = Offset(node.point.x + dx, node.point.y + dy)
                drawLine(Brush.linearGradient(listOf(Color.Transparent, AssistantCardTheme.spark.copy(alpha = 0.55f), Color.Transparent), a, b), a, b, 0.5f * d, blendMode = BlendMode.Plus)
            }
        }
        drawPathEx(circle(node.point, r), SolidColor(AssistantCardTheme.goldBright.copy(alpha = 0.7f * node.intensity)), blur = 4 * d, blend = BlendMode.Plus)
        drawCircle(AssistantCardTheme.spark.copy(alpha = 0.6f + 0.4f * node.intensity), r, node.point, blendMode = BlendMode.Plus)
    }

    // 11. A soft haze of light falling on the upper edge.
    ellipticalGradient(Offset(w * 0.62f, 0f), w / 2, h / 2, listOf(0f to Color(0xFFFFD995).copy(alpha = 0.07f), 1f to Color.Transparent), BlendMode.Screen)

    // 12. Tiny sparks: dust along Claude's sweep, scattered stars for Astra.
    val sparks = if (theme.claude) listOf(
        sweep.point(0.42f) + Offset(0f, -3 * d) to (0.7f to 0.55f), sweep.point(0.72f) + Offset(2 * d, 3 * d) to (0.6f to 0.45f),
        sweep.point(0.8f) + Offset(-3 * d, -4 * d) to (0.5f to 0.35f), Offset(w * 0.86f, h * 0.2f) to (0.6f to 0.35f),
    ) else listOf(
        Offset(w * 0.52f, h * 0.14f) to (0.6f to 0.4f), Offset(w * 0.7f, h * 0.8f) to (0.5f to 0.35f), Offset(w * 0.34f, h * 0.86f) to (0.55f to 0.3f),
        Offset(w * 0.95f, h * 0.55f) to (0.5f to 0.35f), sweep.point(0.6f) + Offset(0f, -3 * d) to (0.6f to 0.45f),
    )
    for ((p, look) in sparks) {
        val (r, o) = look
        drawPathEx(circle(p, r * d), SolidColor(AssistantCardTheme.goldBright.copy(alpha = 0.8f)), blur = 2.5f * d, blend = BlendMode.Plus)
        drawCircle(AssistantCardTheme.spark.copy(alpha = o), r * d, p, blendMode = BlendMode.Plus)
    }

    if (pressed) drawRect(Color.White.copy(alpha = 0.035f))
}

/** Glow, inner light and the lit halo ring shared by both icon halos. */
private fun DrawScope.haloBase(center: Offset, radius: Float, glow: Float, reachFactor: Float, d: Float) {
    radialSpot(center, radius * reachFactor, listOf(0f to AssistantCardTheme.glowCore.copy(alpha = glow), 0.42f to AssistantCardTheme.glowMid.copy(alpha = glow * 0.35f), 1f to AssistantCardTheme.glowMid.copy(alpha = 0f)), BlendMode.Plus)
    radialSpot(center, radius * 0.62f, listOf(0f to Color(0xFFFFE9B8).copy(alpha = 0.18f), 1f to Color.Transparent), BlendMode.Plus)
    val ring = circle(center, radius)
    val ringShading = Brush.linearGradient(listOf(AssistantCardTheme.gold.copy(alpha = 0.12f), AssistantCardTheme.goldBright.copy(alpha = 0.5f)), Offset(center.x - radius, center.y + radius), Offset(center.x + radius, center.y - radius))
    drawPathEx(ring, ringShading, strokeWidth = 2.5f * d, blur = 3 * d, blend = BlendMode.Plus)
    drawPathEx(ring, ringShading, strokeWidth = 0.8f * d, blend = BlendMode.Plus)
}

/** Claude: radiant glow with a fine starburst behind the mark. */
private fun DrawScope.claudeHalo(center: Offset, radius: Float, glow: Float, d: Float) {
    haloBase(center, radius, glow, 1.5f, d)
    val rays = Path()
    val longRays = Path()
    val count = 44
    for (index in 0 until count) {
        val angle = index.toFloat() / count * 2 * PI.toFloat()
        val variation = ((index * 37) % 11) / 10f
        val inner = radius * 0.55f
        val outer = radius * (0.88f + 0.5f * variation)
        val target = if (variation > 0.6f) longRays else rays
        target.moveTo(center.x + inner * cos(angle), center.y + inner * sin(angle))
        target.lineTo(center.x + outer * cos(angle), center.y + outer * sin(angle))
    }
    val rayShading = Brush.radialGradient(
        0f to AssistantCardTheme.goldBright.copy(alpha = 0.32f), 0.357f to AssistantCardTheme.goldBright.copy(alpha = 0.32f), 1f to AssistantCardTheme.gold.copy(alpha = 0f),
        center = center, radius = radius * 1.4f,
    )
    drawPathEx(longRays, rayShading, strokeWidth = 1.4f * d, blur = 1.5f * d, blend = BlendMode.Plus)
    drawPathEx(rays, rayShading, strokeWidth = 0.45f * d, blend = BlendMode.Plus)
    drawPathEx(longRays, rayShading, strokeWidth = 0.6f * d, blend = BlendMode.Plus)
    drawPathEx(circle(center, radius + 7 * d), SolidColor(AssistantCardTheme.gold.copy(alpha = 0.08f)), strokeWidth = 0.5f * d, blend = BlendMode.Plus)
}

/** Astra: an orbital halo with a lit arc, ticks, a dashed outer ring and a tilted inner orbit. */
private fun DrawScope.astraHalo(center: Offset, radius: Float, glow: Float, d: Float) {
    haloBase(center, radius, glow, 1.4f, d)
    val pi = PI.toFloat()
    val arc = Path().apply {
        arcTo(androidx.compose.ui.geometry.Rect(center.x - radius, center.y - radius, center.x + radius, center.y + radius),
            Math.toDegrees((-0.78f * pi).toDouble()).toFloat(), Math.toDegrees((0.42f * pi).toDouble()).toFloat(), true)
    }
    drawPathEx(arc, SolidColor(AssistantCardTheme.goldBright.copy(alpha = 0.5f)), strokeWidth = 2 * d, blur = 2 * d, blend = BlendMode.Plus)
    drawPathEx(arc, SolidColor(AssistantCardTheme.goldBright.copy(alpha = 0.7f)), strokeWidth = 1 * d, blend = BlendMode.Plus)
    val ticks = Path()
    for (i in 0 until 4) {
        val angle = i * pi / 2 + pi / 4
        ticks.moveTo(center.x + (radius + 2 * d) * cos(angle), center.y + (radius + 2 * d) * sin(angle))
        ticks.lineTo(center.x + (radius + 5 * d) * cos(angle), center.y + (radius + 5 * d) * sin(angle))
    }
    drawPathEx(ticks, SolidColor(AssistantCardTheme.goldBright.copy(alpha = 0.32f)), strokeWidth = 0.6f * d, blend = BlendMode.Plus)
    drawPathEx(circle(center, radius + 8 * d), SolidColor(AssistantCardTheme.gold.copy(alpha = 0.2f)), strokeWidth = 0.5f * d, blend = BlendMode.Plus, dash = floatArrayOf(1 * d, 3.2f * d))
    val inner = OrbitPass(OrbitPass.Kind.Ellipse(center, radius + 12 * d, radius * 0.42f, -0.5f, 0f, 2 * pi), 0.22f, 0.55f)
    drawPathEx(inner.path, inner.shading(AssistantCardTheme.goldBright, inner.opacity), strokeWidth = inner.width * d, blend = BlendMode.Plus)
}

/** The chevron as a small glass orb with its own glow, highlight and gold rim. */
@Composable
private fun ChevronOrb(size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val r = this.size.width / 2
            val c = center
            val d = density
            drawPathEx(circle(c, r), SolidColor(AssistantCardTheme.gold.copy(alpha = 0.2f)), blur = 6 * d)
            drawCircle(Brush.radialGradient(listOf(Color(0xFF3D342A), Color(0xFF241F1A), Color(0xFF14120F)), Offset(this.size.width * 0.35f, this.size.height * 0.3f), this.size.width * 0.75f), r, c, alpha = 0.95f)
            drawCircle(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.35f)), startY = c.y, endY = this.size.height), r, c)
            drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.18f), Color.Transparent), Offset(this.size.width * 0.3f, this.size.height * 0.22f), this.size.width * 0.45f), r, c)
            drawPathEx(circle(c, r - 0.45f * d), Brush.linearGradient(
                0f to AssistantCardTheme.goldBright.copy(alpha = 0.85f), 0.5f to Color(0xFFB97825).copy(alpha = 0.55f), 1f to Color(0xFF6E4515).copy(alpha = 0.5f),
                start = Offset(this.size.width, 0f), end = Offset(0f, this.size.height),
            ), strokeWidth = 0.9f * d)
            drawPathEx(circle(c, r - 1.6f * d), SolidColor(Color.White.copy(alpha = 0.06f)), strokeWidth = 0.5f * d)
        }
        SymbolIcon(Symbol.ChevronRight, 16.dp, AssistantCardTheme.chevron)
    }
}

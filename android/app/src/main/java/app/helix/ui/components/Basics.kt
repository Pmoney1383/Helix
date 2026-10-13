package app.helix.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.helix.model.Conversation
import app.helix.model.Logo
import app.helix.model.RelativeTime
import app.helix.model.TileIcon
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.LogoPaths
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.semibold
import java.time.Instant
import kotlinx.coroutines.delay

/** Re-reads the clock every `periodMs` (SwiftUI's `TimelineView(.periodic)`). */
@Composable
fun rememberNow(periodMs: Long = 60_000): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(periodMs) { while (true) { delay(periodMs); now = Instant.now() } }
    return now
}

/** A size that grows with the phone's font scale, like `@ScaledMetric`. */
@Composable
fun scaled(base: Dp): Dp = base * LocalDensity.current.fontScale.coerceAtMost(1.6f)

/** The gold orbit mark: two crossed orbits. */
@Composable
fun HelixMark(size: Dp = 44.dp, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    Canvas(modifier.size(size)) {
        val s = this.size.width
        val w = s * 0.96f
        val h = s * 0.46f
        val line = s * 0.085f
        val brush = Brush.linearGradient(listOf(HelixColors.goldHighlight, HelixColors.gold, HelixColors.goldMid), Offset(0f, 0f), Offset(s, s))
        val glow = with(density) { (size * 0.16f).toPx() }
        for (angle in listOf(-38f, 38f)) {
            rotate(angle) {
                val path = ellipse(center, w / 2, h / 2)
                drawPathEx(path, androidx.compose.ui.graphics.SolidColor(HelixColors.gold.copy(alpha = 0.5f)), strokeWidth = line, blur = glow)
                drawPathEx(path, brush, strokeWidth = line)
            }
        }
    }
}

/** A provider mark, finished in champagne gold with a warm glow (the iPhone's BrandLogo). */
@Composable
fun BrandLogo(logo: Logo, size: Dp, glow: Float = 0.35f, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val data = if (logo == Logo.Claude) LogoPaths.Claude else LogoPaths.OpenAI
    val path = remember(data) { PathParser().parsePathString(data).toPath() }
    Canvas(modifier.size(size)) {
        val scale = this.size.width / 24f
        val brush = Brush.verticalGradient(listOf(androidx.compose.ui.graphics.Color(0xFFFFD77C), androidx.compose.ui.graphics.Color(0xFFF4A735)), 0f, 24f)
        drawContext.canvas.save()
        drawContext.canvas.scale(scale, scale)
        drawPathEx(path, androidx.compose.ui.graphics.SolidColor(androidx.compose.ui.graphics.Color(0xFFF4A735).copy(alpha = glow)), blur = with(density) { 7.dp.toPx() } / scale)
        drawPath(path, brush)
        drawContext.canvas.restore()
    }
}

@Composable
fun IconTile(icon: TileIcon, tint: Color = HelixColors.goldLight, size: Dp = 44.dp) {
    val s = scaled(size)
    Box(
        Modifier
            .size(s)
            .clip(RoundedCornerShape(Radius.icon))
            .background(HelixColors.surfaceWarm)
            .border(1.dp, HelixColors.borderWarm.copy(alpha = 0.6f), RoundedCornerShape(Radius.icon)),
        contentAlignment = Alignment.Center,
    ) {
        when (icon) {
            is TileIcon.Monogram -> Text(icon.text, style = HelixType.headline.copy(fontWeight = FontWeight.Bold), color = tint)
            is TileIcon.Sym -> SymbolIcon(icon.symbol, s * 0.5f, tint)
            is TileIcon.Brand -> BrandLogo(icon.logo, s * 0.52f)
        }
    }
}

@Composable
fun StatusPill(isOnline: Boolean) {
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (isOnline) HelixColors.onlineBg else HelixColors.surfaceSecondary)
            .border(1.dp, (if (isOnline) HelixColors.online else HelixColors.borderWarm).copy(alpha = 0.25f), CircleShape)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Canvas(Modifier.size(8.dp)) {
            if (isOnline) drawPathEx(circle(center, size.width / 2), androidx.compose.ui.graphics.SolidColor(HelixColors.online.copy(alpha = 0.8f)), blur = 4.dp.toPx())
            drawCircle(if (isOnline) HelixColors.online else HelixColors.textMuted)
        }
        Text(if (isOnline) "Gateway Online" else "Gateway Offline", style = HelixType.footnote.copy(fontWeight = FontWeight.Medium), color = HelixColors.textPrimary)
    }
}

/** Secondary shortcut tiles (Check Status, Approvals). */
@Composable
fun ActionTile(title: String, subtitle: String, symbol: Symbol, badge: Int = 0, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .fillMaxHeight()
            .helixCard(radius = Radius.tile)
            .padding(horizontal = Spacing.md, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box {
            IconTile(TileIcon.Sym(symbol), size = 40.dp)
            if (badge > 0) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(6.dp, (-6).dp)
                        .defaultMinSize(18.dp, 18.dp)
                        .clip(CircleShape)
                        .background(HelixColors.gold)
                        .padding(horizontal = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("$badge", style = HelixType.caption2.copy(fontWeight = FontWeight.Bold), color = HelixColors.onGold)
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
            Text(subtitle, style = HelixType.caption, color = HelixColors.textSecondary)
        }
        SymbolIcon(Symbol.ChevronRight, 16.dp, HelixColors.textSecondary)
    }
}

@Composable
fun SectionHeader(title: String, accessory: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HelixType.title3.semibold, color = HelixColors.textPrimary, modifier = Modifier.weight(1f))
        accessory()
    }
}

@Composable
fun RecentRow(conversation: Conversation) {
    val now = rememberNow()
    Row(Modifier.fillMaxWidth().padding(vertical = Spacing.md), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
        IconTile(conversation.icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(conversation.title, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${conversation.typeLabel} • ${RelativeTime.short(conversation.lastActivityAt, now)}", style = HelixType.footnote, color = HelixColors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        SymbolIcon(Symbol.ChevronRight, 16.dp, HelixColors.textSecondary)
    }
}

/** Side by side, stacked once the font scale reaches the accessibility range (AdaptiveRow). */
@Composable
fun AdaptiveRow(spacing: Dp = Spacing.md, content: @Composable (Modifier) -> Unit) {
    if (LocalDensity.current.fontScale >= 1.6f) {
        Column(verticalArrangement = Arrangement.spacedBy(spacing)) { content(Modifier.fillMaxWidth()) }
    } else {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(spacing)) { content(Modifier.weight(1f)) }
    }
}

/** Rows inside one card, separated by hairlines. */
@Composable
fun <T> CardList(items: List<T>, row: @Composable (T) -> Unit) {
    Column(Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(horizontal = Spacing.lg)) {
        items.forEachIndexed { index, item ->
            Box(Modifier.padding(vertical = Spacing.md)) { row(item) }
            if (index != items.lastIndex) HorizontalDivider(thickness = 0.5.dp, color = HelixColors.borderWarm.copy(alpha = 0.6f))
        }
    }
}

/** A soft text shadow (SwiftUI `.shadow(color:radius:)` on text). */
fun textGlow(color: Color, radius: Float) = Shadow(color = color, offset = Offset.Zero, blurRadius = radius)

@Composable
fun HSpacer(width: Dp) = Spacer(Modifier.width(width))

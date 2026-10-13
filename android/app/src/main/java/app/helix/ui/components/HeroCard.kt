package app.helix.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.helix.model.DurationText
import app.helix.model.HeroUpdate
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.bold
import app.helix.ui.theme.monospacedDigit
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable

@Composable
fun HeroCard(update: HeroUpdate, onOpen: () -> Unit, onCall: () -> Unit, onHide: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(Radius.card)
    Box(
        Modifier
            .fillMaxWidth()
            .shadow(16.dp, shape, ambientColor = Color.Black.copy(alpha = 0.4f), spotColor = HelixColors.gold.copy(alpha = 0.15f))
            .clip(shape)
            .background(Color.Black)
            .tappable(onClick = onOpen),
    ) {
        HorizonGlow(Modifier.matchParentSize())
        Column(Modifier.fillMaxWidth().padding(Spacing.xl), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SymbolIcon(Symbol.Sparkle, 14.dp, HelixColors.goldText)
                    Text(
                        update.eyebrow.uppercase(),
                        style = HelixType.caption.semibold.copy(letterSpacing = 0.8.sp, shadow = textGlow(HelixColors.gold.copy(alpha = 0.55f), 10f)),
                        color = HelixColors.goldText,
                    )
                }
                Box {
                    Box(Modifier.size(44.dp).offset(x = Spacing.md).tappable { menu = true }, contentAlignment = Alignment.Center) {
                        SymbolIcon(Symbol.More, 22.dp, HelixColors.textSecondary)
                    }
                    HelixMenu(expanded = menu, onDismiss = { menu = false }, items = listOf(
                        MenuItem("Open Session", Symbol.Chat) { onOpen() },
                        MenuItem("Call About This", Symbol.Call) { onCall() },
                        MenuItem.Divider,
                        MenuItem("Hide Update", Symbol.VisibilityOff) { onHide() },
                    ))
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(update.title, style = HelixType.title2.bold, color = HelixColors.textPrimary)
                Text(update.detail, style = HelixType.subheadline, color = HelixColors.textSecondary)
            }
            update.estimatedCompletion?.let { eta ->
                EstimatedCompletionRow(update.etaLabel, eta, Modifier.padding(top = Spacing.xs))
            }
            Spacer(Modifier.height(52.dp))
        }
        HeroBorder(Modifier.matchParentSize())
    }
}

@Composable
private fun EstimatedCompletionRow(label: String, eta: java.time.Instant, modifier: Modifier) {
    val now = rememberNow(30_000)
    Row(
        modifier
            .fillMaxWidth()
            .drawBehind {
                val r = CornerRadius(size.height / 2)
                drawRoundRect(Color.Black.copy(alpha = 0.3f), cornerRadius = r)
                drawRoundRect(Brush.verticalGradient(listOf(Color(0xFFFFE2A8).copy(alpha = 0.08f), Color.Transparent, Color.Black.copy(alpha = 0.25f))), cornerRadius = r)
            }
            .border(0.8.dp, Brush.verticalGradient(listOf(Color(0xFFFFE2A8).copy(alpha = 0.22f), HelixColors.goldMid.copy(alpha = 0.18f), HelixColors.goldMid.copy(alpha = 0.32f))), CircleShape)
            .padding(Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        SymbolIcon(Symbol.Clock, 15.dp, HelixColors.textSecondary)
        Text(label, style = HelixType.footnote, color = HelixColors.textSecondary, modifier = Modifier.weight(1f))
        Text(DurationText.short(DurationText.between(now, eta)), style = HelixType.subheadline.semibold.monospacedDigit, color = HelixColors.textPrimary)
    }
}

/** Illuminated border: dim at the top, catching the sunrise toward the bottom and right. */
@Composable
private fun HeroBorder(modifier: Modifier) {
    Canvas(modifier) {
        val r = Radius.card.toPx()
        val gradient = Brush.linearGradient(
            0f to Color(0xFF6E4A1E), 0.35f to Color(0xFF8A5A20), 0.72f to Color(0xFFD99B38), 1f to Color(0xFFFFD77C),
            start = Offset.Zero, end = Offset(size.width, size.height),
        )
        illuminatedBorder(r, gradient, outerBlur = 10f, outerAlpha = 0.55f, rimAlpha = 0.6f, innerWidth = 10f, innerBlur = 8f, innerAlpha = 0.28f, strokeWidth = 1f, specular = 0.28f, specularStop = 0.22f, hairline = 0.04f)
    }
}

/** The layered, glowing card border shared by the hero card and the call cards. Sizes are in dp. */
internal fun DrawScope.illuminatedBorder(
    radius: Float,
    gradient: Brush,
    outerBlur: Float,
    outerAlpha: Float,
    rimAlpha: Float,
    innerWidth: Float,
    innerBlur: Float,
    innerAlpha: Float,
    strokeWidth: Float,
    specular: Float,
    specularStop: Float,
    hairline: Float,
    hairlineBottom: Float = hairline,
) {
    val d = density
    fun rr(inset: Float) = Path().apply {
        addRoundRect(RoundRect(inset, inset, size.width - inset, size.height - inset, CornerRadius((radius - inset).coerceAtLeast(0f))))
    }
    val outline = rr(0f)
    drawPathEx(outline, gradient, strokeWidth = 3 * d, blur = outerBlur * d, alpha = outerAlpha)
    drawPathEx(outline, gradient, strokeWidth = 1.2f * d, blur = 2.5f * d, alpha = rimAlpha)
    clipPath(outline) { drawPathEx(outline, gradient, strokeWidth = innerWidth * d, blur = innerBlur * d, alpha = innerAlpha) }
    drawPathEx(rr(strokeWidth * d / 2), gradient, strokeWidth = strokeWidth * d)
    drawPathEx(rr(0.3f * d), Brush.verticalGradient(0f to Color.White.copy(alpha = specular), specularStop to Color.White.copy(alpha = 0f)), strokeWidth = 0.6f * d, blend = BlendMode.Plus)
    drawPathEx(rr(2 * d), Brush.verticalGradient(listOf(Color.White.copy(alpha = hairline), Color.White.copy(alpha = hairlineBottom))), strokeWidth = 0.5f * d)
}


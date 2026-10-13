package app.helix.ui.theme

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.helix.R
import kotlin.math.exp

/** Inter, the stand-in for SF Pro (which cannot ship outside Apple platforms). */
val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
    Font(R.font.inter_italic, FontWeight.Normal, FontStyle.Italic),
)

/**
 * Apple's text styles at the default text size, in sp so they follow the phone's font scale like Dynamic Type does.
 * Tracking uses Inter's own size-dependent formula, which mirrors how SF tightens at larger sizes.
 */
object HelixType {
    private fun style(size: Float, lineHeight: Float, weight: FontWeight = FontWeight.Normal) = TextStyle(
        fontFamily = Inter,
        fontSize = size.sp,
        lineHeight = lineHeight.sp,
        fontWeight = weight,
        letterSpacing = (-0.0223f + 0.185f * exp(-0.1745f * size)).em,
    )

    val largeTitle = style(34f, 41f)
    val title = style(28f, 34f)
    val title2 = style(22f, 28f)
    val title3 = style(20f, 25f)
    val headline = style(17f, 22f, FontWeight.SemiBold)
    val body = style(17f, 22f)
    val callout = style(16f, 21f)
    val subheadline = style(15f, 20f)
    val footnote = style(13f, 18f)
    val caption = style(12f, 16f)
    val caption2 = style(11f, 13f)
}

fun TextStyle.weight(weight: FontWeight) = copy(fontWeight = weight)
val TextStyle.semibold get() = weight(FontWeight.SemiBold)
val TextStyle.bold get() = weight(FontWeight.Bold)
val TextStyle.medium get() = weight(FontWeight.Medium)
/** Tabular figures, like SwiftUI's `.monospacedDigit()`. */
val TextStyle.monospacedDigit get() = copy(fontFeatureSettings = "tnum")

object Radius {
    val card = 24.dp
    val action = 22.dp
    val tile = 20.dp
    val icon = 12.dp
}

object Spacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
    val screen = 20.dp
}

/** The app's tint (SwiftUI `.tint(.goldActive)` on the tab view). */
val Tint = HelixColors.goldActive

/** The standard card: a filled rounded rectangle with a 1 dp warm border. */
fun Modifier.helixCard(fill: Color = HelixColors.surface, border: Color = HelixColors.borderWarm, radius: Dp = Radius.card): Modifier {
    val shape = RoundedCornerShape(radius)
    return this.clip(shape).background(fill, shape).border(1.dp, border, shape)
}

/** Small press feedback for custom tappable surfaces (`PressableStyle`): scale 0.97 and fade to 85 %. */
fun Modifier.pressable(shape: Shape? = null, enabled: Boolean = true, onClick: () -> Unit): Modifier = composed {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, tween(180), label = "press")
    val alpha by animateFloatAsState(if (pressed) 0.85f else 1f, tween(180), label = "pressAlpha")
    this
        .graphicsLayer { scaleX = scale; scaleY = scale; this.alpha = alpha }
        .then(if (shape != null) Modifier.clip(shape) else Modifier)
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick)
}

/** A plain tap with no ripple (SwiftUI buttons have no Material ripple). */
fun Modifier.tappable(enabled: Boolean = true, onClick: () -> Unit): Modifier = composed {
    clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = enabled, onClick = onClick)
}

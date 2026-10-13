package app.helix.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.Tint
import app.helix.ui.theme.bold
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable

// iOS chrome drawn in Compose, so the app looks like its iPhone twin: large titles, an inline bar with a glass back
// button, grouped Form sections, the segmented control, switch and slider, menus, alerts and action sheets.

/** Grouped Form surfaces (iOS 26 inset grouped lists). */
val GroupRadius = 26.dp
private val Glass = Color(0xFF232325).copy(alpha = 0.92f)
private val GlassBorder = Color.White.copy(alpha = 0.08f)
private val MenuSurface = Color(0xFF2A2A2C)
private val Separator = Color.White.copy(alpha = 0.12f)
private val IosRed = Color(0xFFFF453A)

/** Material components still used underneath (dropdown container, text selection) follow the app's dark palette. */
@Composable
fun HelixMaterialTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(primary = Tint, surface = MenuSurface, background = HelixColors.bg, onSurface = HelixColors.textPrimary),
        content = content,
    )
}

/** The big left-aligned title at the top of a tab's root screen. */
@Composable
fun LargeTitle(title: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = Spacing.sm, bottom = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HelixType.largeTitle.bold, color = HelixColors.textPrimary, modifier = Modifier.weight(1f))
        trailing()
    }
}

/** A pushed screen's bar: a glass back button and a centred inline title. */
@Composable
fun InlineNavBar(title: String, onBack: () -> Unit, trailing: @Composable () -> Unit = {}) {
    Box(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).height(54.dp).padding(horizontal = 16.dp)) {
        GlassCircleButton(Symbol.Back, onBack, Modifier.align(Alignment.CenterStart), iconSize = 18.dp)
        Text(
            title, style = HelixType.headline, color = HelixColors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(horizontal = 64.dp),
        )
        Box(Modifier.align(Alignment.CenterEnd)) { trailing() }
    }
}

/** A round Liquid Glass button (back, minimise). */
@Composable
fun GlassCircleButton(symbol: Symbol, onClick: () -> Unit, modifier: Modifier = Modifier, size: Dp = 44.dp, iconSize: Dp = 20.dp, tint: Color = HelixColors.textPrimary) {
    Box(
        modifier.size(size).shadow(8.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.3f)).clip(CircleShape)
            .background(Glass).border(0.5.dp, GlassBorder, CircleShape).tappable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { SymbolIcon(symbol, iconSize, tint) }
}

/** The floating Liquid Glass tab bar. */
@Composable
fun TabBar(items: List<Triple<String, Symbol, Boolean>>, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 20.dp, vertical = 6.dp)) {
        Row(
            Modifier.fillMaxWidth().height(64.dp).shadow(18.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.5f))
                .clip(CircleShape).background(Glass).border(0.5.dp, GlassBorder, CircleShape).padding(4.dp),
        ) {
            items.forEachIndexed { index, (label, symbol, selected) ->
                val color by animateColorAsState(if (selected) Tint else HelixColors.textPrimary, tween(150), label = "tab")
                Column(
                    Modifier.weight(1f).height(56.dp).clip(CircleShape)
                        .background(if (selected) Color.White.copy(alpha = 0.1f) else Color.Transparent)
                        .tappable { onSelect(index) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    SymbolIcon(symbol, 24.dp, color)
                    Text(label, style = HelixType.caption2.copy(fontWeight = FontWeight.Medium), color = color)
                }
            }
        }
    }
}

// MARK: Grouped Form sections

@Composable
fun FormSection(header: String? = null, footer: String? = null, background: Color = HelixColors.surface, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        header?.let { Text(it, style = HelixType.footnote.semibold, color = HelixColors.textSecondary, modifier = Modifier.padding(start = 16.dp, bottom = 6.dp)) }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(GroupRadius)).background(background)) { content() }
        footer?.let { Text(it, style = HelixType.footnote, color = HelixColors.textSecondary, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp)) }
    }
}

@Composable
fun FormRow(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, divider: Boolean = true, content: @Composable () -> Unit) {
    Column {
        Box(modifier.fillMaxWidth().then(if (onClick != null) Modifier.tappable(onClick = onClick) else Modifier).defaultMinSize(minHeight = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
            content()
        }
        if (divider) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 0.5.dp, color = Separator)
    }
}

/** A row with a title on the left and a value (or control) on the right (`LabeledContent`). */
@Composable
fun LabeledRow(title: String, value: String? = null, valueColor: Color = HelixColors.textSecondary, chevron: Boolean = false, divider: Boolean = true, onClick: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    FormRow(onClick = onClick, divider = divider) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = HelixType.body, color = HelixColors.textPrimary, modifier = Modifier.weight(1f))
            value?.let { Text(it, style = HelixType.body, color = valueColor) }
            trailing?.invoke()
            if (chevron) { Spacer(Modifier.width(6.dp)); SymbolIcon(Symbol.ChevronRight, 18.dp, HelixColors.textSecondary.copy(alpha = 0.6f)) }
        }
    }
}

@Composable
fun SwitchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true, divider: Boolean = true) {
    FormRow(divider = divider) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = HelixType.body, color = HelixColors.textPrimary.copy(alpha = if (enabled) 1f else 0.4f), modifier = Modifier.weight(1f))
            IosSwitch(checked, onChange, enabled)
        }
    }
}

/** The iOS switch, tinted with the app's gold. */
@Composable
fun IosSwitch(checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    val track by animateColorAsState(if (checked) Tint else Color(0xFF39393D), tween(200), label = "track")
    val x by animateDpAsState(if (checked) 24.dp else 2.dp, tween(200), label = "thumb")
    Box(
        Modifier.size(width = 64.dp, height = 28.dp).clip(CircleShape).background(track.copy(alpha = if (enabled) 1f else 0.4f))
            .tappable(enabled) { onChange(!checked) },
    ) {
        Box(Modifier.offset(x = x).padding(vertical = 2.dp).size(width = 38.dp, height = 24.dp).shadow(2.dp, CircleShape).clip(CircleShape).background(Color.White))
    }
}

/** The iOS slider: a thin track, gold up to the value, a white thumb. */
@Composable
fun IosSlider(value: Float, onChange: (Float) -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val current by rememberUpdatedState(value)
    BoxWithConstraints(
        modifier.fillMaxWidth().height(32.dp)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures { onChange((it.x / size.width).coerceIn(0f, 1f)) }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures { change, _ -> onChange((change.position.x / size.width).coerceIn(0f, 1f)) }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        val width = maxWidth
        Canvas(Modifier.fillMaxWidth().height(4.dp)) {
            drawRoundRect(Color(0xFF39393D), cornerRadius = CornerRadius(2.dp.toPx()))
            drawRoundRect(Tint.copy(alpha = if (enabled) 1f else 0.4f), size = Size(size.width * current, size.height), cornerRadius = CornerRadius(2.dp.toPx()))
        }
        Box(Modifier.offset(x = (width - 38.dp) * current).size(width = 38.dp, height = 24.dp).shadow(3.dp, CircleShape).clip(CircleShape).background(Color.White))
    }
}

/** The segmented control (the Phone Alerts picker). */
@Composable
fun SegmentedControl(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxWidth().height(36.dp).clip(CircleShape).background(Color(0xFF2C2C2E)).padding(2.dp)) {
        val segment = maxWidth / options.size
        val x by animateDpAsState(segment * selected, tween(200), label = "segment")
        Box(Modifier.offset(x = x).width(segment).height(32.dp).shadow(2.dp, CircleShape).clip(CircleShape).background(Color(0xFF636366)))
        Row(Modifier.fillMaxSize()) {
            options.forEachIndexed { index, option ->
                Box(Modifier.weight(1f).height(32.dp).tappable { onSelect(index) }, contentAlignment = Alignment.Center) {
                    Text(option, style = HelixType.footnote.copy(fontWeight = if (index == selected) FontWeight.SemiBold else FontWeight.Medium), color = HelixColors.textPrimary)
                }
            }
        }
    }
}

// MARK: Menus, alerts, action sheets

sealed interface MenuItem {
    data class Action(val title: String, val symbol: Symbol?, val destructive: Boolean = false, val onClick: () -> Unit) : MenuItem
    data class Custom(val title: String, val icon: @Composable () -> Unit, val onClick: () -> Unit) : MenuItem
    data object Divider : MenuItem

    companion object {
        operator fun invoke(title: String, symbol: Symbol?, onClick: () -> Unit): MenuItem = Action(title, symbol, onClick = onClick)
    }
}

/** An iOS context menu: a rounded glass panel, the label on the left and the icon on the right. */
@Composable
fun HelixMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<MenuItem>) {
    HelixMaterialTheme {
        DropdownMenu(
            expanded = expanded, onDismissRequest = onDismiss,
            shape = RoundedCornerShape(22.dp), containerColor = MenuSurface,
            modifier = Modifier.width(250.dp),
        ) {
            items.forEach { item ->
                when (item) {
                    MenuItem.Divider -> Box(Modifier.fillMaxWidth().height(8.dp).background(Color.Black.copy(alpha = 0.2f)))
                    is MenuItem.Action -> MenuRow(item.title, if (item.destructive) IosRed else HelixColors.textPrimary, { item.symbol?.let { SymbolIcon(it, 20.dp, if (item.destructive) IosRed else HelixColors.textPrimary) } }) { onDismiss(); item.onClick() }
                    is MenuItem.Custom -> MenuRow(item.title, HelixColors.textPrimary, item.icon) { onDismiss(); item.onClick() }
                }
            }
        }
    }
}

@Composable
private fun MenuRow(title: String, color: Color, icon: @Composable () -> Unit, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().tappable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HelixType.body, color = color, modifier = Modifier.weight(1f))
        icon()
    }
}

data class DialogButton(val title: String, val role: Role = Role.Default, val onClick: () -> Unit) {
    enum class Role { Default, Cancel, Destructive }
}

/** The iOS alert: a centred glass card with a title, a message and stacked or side-by-side buttons. */
@Composable
fun HelixAlert(title: String, message: String?, buttons: List<DialogButton>, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.width(300.dp).clip(RoundedCornerShape(30.dp)).background(Color(0xFF2C2C2E)).padding(top = 20.dp)) {
            Text(title, style = HelixType.headline, color = HelixColors.textPrimary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            message?.let { Text(it, style = HelixType.footnote, color = HelixColors.textPrimary, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) }
            Spacer(Modifier.height(14.dp))
            Column(Modifier.padding(horizontal = 14.dp).padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                buttons.forEach { b ->
                    Box(
                        Modifier.fillMaxWidth().height(48.dp).clip(CircleShape)
                            .background(if (b.role == DialogButton.Role.Cancel) Color(0xFF3A3A3C) else Color(0xFF3A3A3C))
                            .tappable { onDismiss(); b.onClick() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            b.title,
                            style = HelixType.body.copy(fontWeight = if (b.role == DialogButton.Role.Cancel) FontWeight.SemiBold else FontWeight.Normal),
                            color = when (b.role) { DialogButton.Role.Destructive -> IosRed; DialogButton.Role.Cancel -> HelixColors.textPrimary; else -> Tint },
                        )
                    }
                }
            }
        }
    }
}

/** The iOS confirmation dialog (action sheet) from the bottom: a title and message, actions, and Cancel apart. */
@Composable
fun ActionSheet(title: String, message: String?, actions: List<DialogButton>, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().tappable(onClick = onDismiss), contentAlignment = Alignment.BottomCenter) {
            Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(8.dp).tappable { }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xFF2C2C2E))) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(title, style = HelixType.footnote.semibold, color = HelixColors.textSecondary, textAlign = TextAlign.Center)
                        message?.let { Text(it, style = HelixType.footnote, color = HelixColors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp)) }
                    }
                    actions.filter { it.role != DialogButton.Role.Cancel }.forEach { a ->
                        HorizontalDivider(thickness = 0.5.dp, color = Separator)
                        Box(Modifier.fillMaxWidth().height(56.dp).tappable { onDismiss(); a.onClick() }, contentAlignment = Alignment.Center) {
                            Text(a.title, style = HelixType.title3, color = if (a.role == DialogButton.Role.Destructive) IosRed else Tint)
                        }
                    }
                }
                actions.filter { it.role == DialogButton.Role.Cancel }.forEach { c ->
                    Box(Modifier.fillMaxWidth().height(56.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFF2C2C2E)).tappable { onDismiss(); c.onClick() }, contentAlignment = Alignment.Center) {
                        Text(c.title, style = HelixType.title3.semibold, color = Tint)
                    }
                }
            }
        }
    }
}

// MARK: Text fields, empty states, progress

@Composable
fun HelixTextField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    style: TextStyle = HelixType.body,
    singleLine: Boolean = true,
    maxLines: Int = 1,
    enabled: Boolean = true,
    capitalizeCharacters: Boolean = false,
    autoCapitalize: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Default,
    onSubmit: () -> Unit = {},
) {
    BasicTextField(
        value = value, onValueChange = onChange, enabled = enabled, singleLine = singleLine, maxLines = maxLines,
        textStyle = style.copy(color = HelixColors.textPrimary),
        cursorBrush = SolidColor(Tint),
        keyboardOptions = KeyboardOptions(
            capitalization = when {
                capitalizeCharacters -> androidx.compose.ui.text.input.KeyboardCapitalization.Characters
                !autoCapitalize || keyboardType != KeyboardType.Text -> androidx.compose.ui.text.input.KeyboardCapitalization.None
                else -> androidx.compose.ui.text.input.KeyboardCapitalization.Sentences
            },
            autoCorrectEnabled = autoCapitalize && !capitalizeCharacters && keyboardType == KeyboardType.Text,
            keyboardType = keyboardType, imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onAny = { onSubmit() }),
        modifier = modifier,
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, style = style, color = HelixColors.textSecondary.copy(alpha = 0.7f))
                inner()
            }
        },
    )
}

/** The iOS search field under a large title. */
@Composable
fun SearchField(query: String, onChange: (String) -> Unit, prompt: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(40.dp).clip(CircleShape).background(Color(0xFF1C1C1E)).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        SymbolIcon(Symbol.Search, 18.dp, HelixColors.textSecondary)
        HelixTextField(query, onChange, prompt, Modifier.weight(1f), style = HelixType.body, imeAction = ImeAction.Search)
        if (query.isNotEmpty()) Box(Modifier.size(20.dp).clip(CircleShape).background(HelixColors.textSecondary.copy(alpha = 0.5f)).tappable { onChange("") }, contentAlignment = Alignment.Center) {
            SymbolIcon(Symbol.Close, 14.dp, HelixColors.bg)
        }
    }
}

/** `ContentUnavailableView`: a big symbol, a title, a description and optional actions. */
@Composable
fun ContentUnavailable(symbol: Symbol, title: String, description: String, modifier: Modifier = Modifier, action: Pair<String, () -> Unit>? = null) {
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SymbolIcon(symbol, 48.dp, HelixColors.textSecondary)
        Text(title, style = HelixType.title2.bold, color = HelixColors.textPrimary, textAlign = TextAlign.Center)
        Text(description, style = HelixType.subheadline, color = HelixColors.textSecondary, textAlign = TextAlign.Center)
        action?.let { (label, onClick) ->
            Spacer(Modifier.height(4.dp))
            Text(label, style = HelixType.subheadline.semibold, color = Tint, modifier = Modifier.tappable(onClick = onClick).padding(8.dp))
        }
    }
}

/** The iOS activity indicator (eight fading spokes) with an optional label (`ProgressView("…")`). */
@Composable
fun ActivityIndicator(label: String? = null, size: Dp = 20.dp, color: Color = HelixColors.textSecondary) {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "spinner")
    val step by transition.animateFloat(0f, 8f, androidx.compose.animation.core.infiniteRepeatable(tween(800, easing = androidx.compose.animation.core.LinearEasing)), label = "step")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.size(size)) {
            val r = this.size.minDimension / 2
            val head = step.toInt()
            for (i in 0 until 8) {
                val angle = Math.toRadians((i * 45 - 90).toDouble())
                val alpha = 0.25f + 0.75f * (((i - head + 8) % 8) / 7f).let { 1f - it }
                val start = Offset(center.x + (r * 0.45f) * kotlin.math.cos(angle).toFloat(), center.y + (r * 0.45f) * kotlin.math.sin(angle).toFloat())
                val end = Offset(center.x + r * kotlin.math.cos(angle).toFloat(), center.y + r * kotlin.math.sin(angle).toFloat())
                drawLine(color.copy(alpha = alpha), start, end, strokeWidth = r * 0.22f, cap = StrokeCap.Round)
            }
        }
        label?.let { Text(it, style = HelixType.subheadline, color = HelixColors.textSecondary) }
    }
}

/** A plain gold text button (`Button("Retry")`). */
@Composable
fun TextButton(title: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Text(
        title, style = HelixType.body, color = if (enabled) Tint else HelixColors.textSecondary.copy(alpha = 0.5f),
        modifier = modifier.defaultMinSize(minHeight = 44.dp).tappable(enabled, onClick).padding(vertical = 11.dp),
    )
}

/** The status-bar fade at the top of screens without a navigation bar. */
@Composable
fun StatusBarFade(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).height(12.dp)) {
        Canvas(Modifier.fillMaxSize()) { drawRect(Brush.verticalGradient(listOf(HelixColors.bg, HelixColors.bg.copy(alpha = 0f)))) }
    }
}


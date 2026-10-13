package app.helix.ui.theme

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The icons: Material Symbols Rounded standing in for the iPhone's SF Symbols. Each notes the SF Symbol it replaces.
 * Filled variants exist where the iPhone uses a `.fill` symbol, or where iOS fills a selected tab.
 */
enum class Symbol(internal val path: SymbolPath) {
    Home(SymbolPaths.Home), HomeFill(SymbolPaths.HomeFill), // house
    Chat(SymbolPaths.Chat), ChatFill(SymbolPaths.ChatFill), // bubble.left
    Call(SymbolPaths.Call), CallFill(SymbolPaths.CallFill), // phone, phone.fill
    Settings(SymbolPaths.Settings), SettingsFill(SymbolPaths.SettingsFill), // gearshape
    BarChart(SymbolPaths.BarChart), // chart.bar.fill
    VerifiedUser(SymbolPaths.VerifiedUser), // checkmark.shield
    ChevronRight(SymbolPaths.ChevronRight), // chevron.right
    Sparkle(SparklePath), // sparkle: drawn here, Material has no plain four-point star
    More(SymbolPaths.MoreHoriz), // ellipsis
    VisibilityOff(SymbolPaths.VisibilityOff), // eye.slash
    Clock(SymbolPaths.Schedule), // clock
    Desktop(SymbolPaths.DesktopWindows), // desktopcomputer
    Forum(SymbolPaths.Forum), // bubble.left.and.bubble.right
    AddCircleFill(SymbolPaths.AddCircleFill), // plus.circle.fill
    Branch(SymbolPaths.ForkRight), // arrow.triangle.branch
    BellBadge(SymbolPaths.NotificationsActive), // bell.badge
    Warning(SymbolPaths.Warning), WarningFill(SymbolPaths.WarningFill), // exclamationmark.triangle(.fill)
    ArrowUp(SymbolPaths.ArrowUpward), // arrow.up
    CallEnd(SymbolPaths.CallEnd), CallEndFill(SymbolPaths.CallEndFill), // phone.down(.fill)
    CallIncoming(SymbolPaths.CallReceived), // phone.arrow.down.left
    CallOutgoing(SymbolPaths.CallMade), // phone.arrow.up.right
    ChevronDown(SymbolPaths.ExpandMore), // chevron.down
    MicFill(SymbolPaths.MicFill), MicOffFill(SymbolPaths.MicOffFill), // mic.fill, mic.slash.fill
    Speaker(SymbolPaths.VolumeUpFill), Bluetooth(SymbolPaths.Bluetooth), Earpiece(SymbolPaths.PhoneInTalkFill),
    Headphones(SymbolPaths.HeadphonesFill), // the AirPlay route picker
    Trash(SymbolPaths.Delete), // trash
    Timer(SymbolPaths.Timer), // timer
    ExclamationCircle(SymbolPaths.Error), // exclamationmark.circle
    CheckCircleFill(SymbolPaths.CheckCircleFill), // checkmark.circle.fill
    XCircleFill(SymbolPaths.CancelFill), // xmark.circle.fill
    Eye(SymbolPaths.Visibility), // eye
    Slower(SymbolPaths.DirectionsWalk), Faster(SymbolPaths.DirectionsRun), // tortoise.fill, hare.fill
    Back(SymbolPaths.ArrowBackIos), // chevron.backward
    Search(SymbolPaths.Search), // magnifyingglass
    ForkKnife(SymbolPaths.Restaurant), // fork.knife
    Code(SymbolPaths.Code), // chevron.left.forwardslash.chevron.right
    Close(SymbolPaths.Close), // xmark
    Shield(SymbolPaths.Shield),
    Phone(SymbolPaths.Smartphone);

    val vector: ImageVector get() = vectorCache.getOrPut(this) { buildVector(name, path) }
}

/** SF Symbols' "sparkle": a concave four-point star, in the same 960-unit canvas as Material Symbols. */
private val SparklePath = SymbolPath("M480-880Q520-520 880-480Q520-440 480-80Q440-440 80-480Q440-520 480-880Z", 960)

private val vectorCache = HashMap<Symbol, ImageVector>()

/** The SVG path in a 24 dp vector. A 960-unit path's viewBox is (0 -960 960 960), hence the group moved down by 960. */
private fun buildVector(name: String, path: SymbolPath): ImageVector {
    val units = path.units.toFloat()
    return ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = units, viewportHeight = units)
        .addGroup(translationY = if (path.units == 960) 960f else 0f)
        .addPath(pathData = PathParser().parsePathString(path.d).toNodes(), fill = SolidColor(Color.Black))
        .clearGroup()
        .build()
}

@Composable
fun SymbolIcon(symbol: Symbol, size: Dp, tint: Color, modifier: Modifier = Modifier) {
    Image(
        imageVector = symbol.vector,
        contentDescription = null,
        colorFilter = ColorFilter.tint(tint),
        modifier = modifier.size(size),
    )
}

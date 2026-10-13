package app.helix.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.helix.call.CallAudioManager
import app.helix.model.ActiveCall
import app.helix.model.Call
import app.helix.model.CallDirection
import app.helix.model.CallPhase
import app.helix.model.CallStatus
import app.helix.model.DurationText
import app.helix.model.FrontDoor
import app.helix.model.MessageSender
import app.helix.model.Provider
import app.helix.model.RelativeTime
import app.helix.model.Severity
import app.helix.model.TileIcon
import app.helix.store.HelixStore
import app.helix.store.RingingCall
import app.helix.ui.components.AdaptiveRow
import app.helix.ui.components.AssistantCallCard
import app.helix.ui.components.CardList
import app.helix.ui.components.GlassCircleButton
import app.helix.ui.components.HelixMark
import app.helix.ui.components.HelixMenu
import app.helix.ui.components.IconTile
import app.helix.ui.components.LargeTitle
import app.helix.ui.components.MenuItem
import app.helix.ui.components.SectionHeader
import app.helix.ui.components.drawPathEx
import app.helix.ui.components.circle
import app.helix.ui.components.rememberNow
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.bold
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.medium
import app.helix.ui.theme.monospacedDigit
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable

private val CallRed = Color(0xFFFF453A)

@Composable
fun CallsScreen(store: HelixStore) {
    LaunchedEffect(Unit) { store.warmVoice() }
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars).verticalScroll(rememberScrollState()).padding(bottom = TabBarClearance)) {
        LargeTitle("Calls")
        Column(Modifier.padding(horizontal = Spacing.screen, vertical = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.xl)) {
            AdaptiveRow { m ->
                AssistantCallCard(FrontDoor.Claude, m) { store.startCall(FrontDoor.Claude) }
                AssistantCallCard(FrontDoor.Codex, m) { store.startCall(FrontDoor.Codex) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                SectionHeader("Recent")
                if (store.calls.isEmpty()) {
                    Text("Calls you make, and calls Helix makes to you, show up here.", style = HelixType.subheadline, color = HelixColors.textSecondary,
                        modifier = Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(Spacing.lg))
                } else {
                    CardList(store.calls) { call ->
                        Box(Modifier.tappable { store.startCall(if (call.provider == Provider.Claude) FrontDoor.Claude else FrontDoor.Codex) }) { CallRow(call) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CallRow(call: Call) {
    val now = rememberNow()
    val missed = call.status == CallStatus.Missed
    val symbol = when {
        call.status == CallStatus.Missed || call.status == CallStatus.Declined -> Symbol.CallEnd
        call.direction == CallDirection.Incoming -> Symbol.CallIncoming
        else -> Symbol.CallOutgoing
    }
    val direction = if (missed) "Missed" else if (call.direction == CallDirection.Incoming) "Incoming" else "Outgoing"
    val duration = call.duration?.let { " • ${DurationText.short(it)}" } ?: ""
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
        IconTile(TileIcon.Sym(symbol), tint = if (missed) CallRed else HelixColors.goldLight)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(call.title, style = HelixType.subheadline.semibold, color = if (missed) CallRed else HelixColors.textPrimary)
                if (call.severity == Severity.Critical) {
                    Text("Urgent", style = HelixType.caption2.copy(fontWeight = FontWeight.Bold), color = CallRed,
                        modifier = Modifier.clip(CircleShape).background(CallRed.copy(alpha = 0.15f)).padding(horizontal = 6.dp, vertical = 2.dp))
                }
            }
            Text("$direction$duration • ${call.summary}", style = HelixType.footnote, color = HelixColors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(RelativeTime.short(call.createdAt, now), style = HelixType.footnote, color = HelixColors.textSecondary)
    }
}

/** The in-app call screen. */
@Composable
fun CallScreen(store: HelixStore) {
    val call = store.activeCall ?: return
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(call.phase) { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
    Box(Modifier.fillMaxSize().background(HelixColors.bg).tappable { }) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(Brush.radialGradient(listOf(HelixColors.goldDeep.copy(alpha = 0.35f), Color.Transparent), center = center, radius = 360.dp.toPx()))
        }
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = Spacing.xxl, vertical = Spacing.lg),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            Row(Modifier.fillMaxWidth()) { GlassCircleButton(Symbol.ChevronDown, { store.callScreenHidden = true }, iconSize = 26.dp) }
            CallHeader(call)
            Spacer(Modifier.weight(1f))
            CallOrb(call.phase)
            Spacer(Modifier.weight(1f))
            Transcript(call)
            Controls(store)
        }
    }
}

@Composable
private fun CallHeader(call: ActiveCall) {
    val now = rememberNow(1_000)
    val clock = DurationText.clock(DurationText.between(call.startedAt, now))
    Column(Modifier.padding(top = Spacing.xxl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(call.title, style = HelixType.largeTitle.bold, color = HelixColors.textPrimary, textAlign = TextAlign.Center)
        Text(
            when (call.phase) { CallPhase.Connecting -> "Connecting…"; CallPhase.Speaking -> "Speaking • $clock"; CallPhase.Listening -> "Listening • $clock" },
            style = HelixType.headline.monospacedDigit, color = HelixColors.textSecondary,
        )
    }
}

@Composable
private fun Transcript(call: ActiveCall) {
    Column(Modifier.fillMaxWidth().defaultMinSize(minHeight = 60.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        for (line in call.transcript.takeLast(2)) {
            AnimatedContent(line, transitionSpec = { (fadeIn() + slideInVertically { it / 2 }) togetherWith fadeOut() }, label = "line") { l ->
                Text(
                    l.text, textAlign = TextAlign.Center,
                    style = if (l.speaker == MessageSender.Agent) HelixType.title3.medium else HelixType.body,
                    color = if (l.speaker == MessageSender.Agent) HelixColors.textPrimary else HelixColors.textSecondary,
                )
            }
        }
    }
}

@Composable
private fun Controls(store: HelixStore) {
    var routes by remember { mutableStateOf(false) }
    Row(Modifier.padding(bottom = Spacing.lg), horizontalArrangement = Arrangement.spacedBy(Spacing.xxl)) {
        CallControl(if (store.isMuted) "Unmute" else "Mute", if (store.isMuted) Symbol.MicOffFill else Symbol.MicFill, on = store.isMuted) { store.mute(!store.isMuted) }
        Box {
            // The route picker lists every available output: earpiece, speaker, Bluetooth (headsets, the car), wired.
            CallControl("Audio", routeSymbol(store.audioRoute), on = false) { routes = true }
            HelixMenu(routes, { routes = false }, store.availableAudioRoutes.map { r -> MenuItem(routeName(r), routeSymbol(r)) { store.routeAudio(r) } })
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Box(Modifier.size(72.dp).clip(CircleShape).background(CallRed).tappable { store.endCall() }, contentAlignment = Alignment.Center) {
                SymbolIcon(Symbol.CallEndFill, 30.dp, Color.White)
            }
            Text("End", style = HelixType.footnote, color = HelixColors.textSecondary)
        }
    }
}

private fun routeSymbol(r: CallAudioManager.Route) = when (r) {
    CallAudioManager.Route.Speaker -> Symbol.Speaker
    CallAudioManager.Route.Bluetooth -> Symbol.Bluetooth
    CallAudioManager.Route.Headset -> Symbol.Headphones
    CallAudioManager.Route.Earpiece -> Symbol.Earpiece
}

private fun routeName(r: CallAudioManager.Route) = when (r) {
    CallAudioManager.Route.Speaker -> "Speaker"
    CallAudioManager.Route.Bluetooth -> "Bluetooth"
    CallAudioManager.Route.Headset -> "Headphones"
    CallAudioManager.Route.Earpiece -> "Phone"
}

@Composable
private fun CallControl(title: String, symbol: Symbol, on: Boolean, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(
            Modifier.size(72.dp).clip(CircleShape).background(if (on) HelixColors.gold else Color.White.copy(alpha = 0.12f))
                .border(0.5.dp, Color.White.copy(alpha = 0.12f), CircleShape).tappable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) { SymbolIcon(symbol, 28.dp, if (on) HelixColors.onGold else HelixColors.textPrimary) }
        Text(title, style = HelixType.footnote, color = HelixColors.textSecondary)
    }
}

@Composable
private fun CallOrb(phase: CallPhase) {
    val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(1f, 1.06f, infiniteRepeatable(tween(1600, easing = EaseInOut), RepeatMode.Reverse), label = "rings")
    val glow by animateFloatAsState(if (phase == CallPhase.Speaking) 1f else 0.6f, tween(600), label = "glow")
    Box(Modifier.size(300.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(300.dp)) {
            for (ring in 0 until 3) {
                val r = (180 + ring * 50).dp.toPx() / 2 * (if (phase != CallPhase.Connecting) pulse else 1f)
                drawCircle(HelixColors.gold.copy(alpha = 0.18f - ring * 0.05f), r, style = Stroke(1.dp.toPx()))
            }
            drawPathEx(
                circle(center, 110.dp.toPx()),
                Brush.radialGradient(listOf(HelixColors.goldHighlight.copy(alpha = 0.9f), HelixColors.gold.copy(alpha = 0.55f), HelixColors.goldDeep.copy(alpha = 0f)), center, 110.dp.toPx()),
                blur = 20.dp.toPx(), alpha = glow,
            )
            drawCircle(HelixColors.bg, 66.dp.toPx())
            drawCircle(HelixColors.goldMid.copy(alpha = 0.6f), 65.5.dp.toPx(), style = Stroke(1.dp.toPx()))
        }
        HelixMark(72.dp)
    }
}

/** The ring, in the app: Android has no CallKit screen to draw it for us when the app is open. */
@Composable
fun IncomingCallScreen(store: HelixStore, ringing: RingingCall) {
    Box(Modifier.fillMaxSize().background(HelixColors.bg).tappable { }) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(Brush.radialGradient(listOf(HelixColors.goldDeep.copy(alpha = 0.35f), Color.Transparent), center = center, radius = 360.dp.toPx()))
        }
        Column(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(Spacing.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.size(48.dp))
            Text(ringing.caller, style = HelixType.largeTitle.bold, color = HelixColors.textPrimary)
            Text(ringing.title.ifEmpty { "Incoming call" }, style = HelixType.headline, color = HelixColors.textSecondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = Spacing.xs))
            Spacer(Modifier.weight(1f))
            CallOrb(CallPhase.Speaking)
            Spacer(Modifier.weight(1f))
            Row(Modifier.fillMaxWidth().padding(bottom = Spacing.xxl), horizontalArrangement = Arrangement.SpaceEvenly) {
                RingButton("Decline", Symbol.CallEndFill, CallRed) { store.declineRinging() }
                RingButton("Answer", Symbol.CallFill, Color(0xFF30D158)) { store.answerRinging() }
            }
        }
    }
}

@Composable
private fun RingButton(title: String, symbol: Symbol, color: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(Modifier.size(76.dp).clip(CircleShape).background(color).tappable(onClick = onClick), contentAlignment = Alignment.Center) {
            SymbolIcon(symbol, 32.dp, Color.White)
        }
        Text(title, style = HelixType.footnote, color = HelixColors.textSecondary)
    }
}


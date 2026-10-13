package app.helix.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.helix.model.AgentSession
import app.helix.model.LiveStatus
import app.helix.model.Provider
import app.helix.model.RelativeTime
import app.helix.model.Severity
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.Screen
import app.helix.ui.components.ActivityIndicator
import app.helix.ui.components.AdaptiveRow
import app.helix.ui.components.CardList
import app.helix.ui.components.InlineNavBar
import app.helix.ui.components.LargeTitle
import app.helix.ui.components.SectionHeader
import app.helix.ui.components.StatusPill
import app.helix.ui.components.TextButton
import app.helix.ui.components.rememberNow
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.medium
import app.helix.ui.theme.monospacedDigit
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** "Check Status": gateway health, PC load, live agent sessions and watchers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatusScreen(store: HelixStore, nav: Navigator) {
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    // Live while the screen is open: refresh now and every 10 s.
    LaunchedEffect(Unit) { while (isActive) { store.refreshStatus(); delay(10_000) } }
    Column(Modifier.fillMaxSize().background(HelixColors.bg)) {
        InlineNavBar("", onBack = { nav.pop() })
        PullToRefreshBox(refreshing, { scope.launch { refreshing = true; store.refreshStatus(); refreshing = false } }, Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = TabBarClearance)) {
                LargeTitle("Status")
                Column(Modifier.padding(horizontal = Spacing.screen, vertical = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xl)) {
                    GatewayCard(store)
                    PcCard(store)
                    SessionsCard(store, nav)
                    WatchersCard(store)
                }
            }
        }
    }
}

@Composable
private fun GatewayCard(store: HelixStore) {
    val now = rememberNow(30_000)
    Row(Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(Spacing.lg), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(store.gateway.hostName, style = HelixType.headline, color = HelixColors.textPrimary)
            Text("Last heartbeat ${RelativeTime.short(store.gateway.lastHeartbeat, now)}", style = HelixType.footnote, color = HelixColors.textSecondary)
            store.gatewayUptimeSec?.let { Text("Gateway up ${duration(it)}", style = HelixType.footnote, color = HelixColors.textSecondary) }
        }
        StatusPill(store.gateway.isOnline)
    }
}

@Composable
private fun PcCard(store: HelixStore) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SectionHeader("This PC")
        val report = store.pcReport
        when {
            !store.isPaired -> Meters(store.pc.cpu, store.pc.gpu, store.pc.gpuName, store.pc.memory)
            report != null -> {
                val card = report.gpu?.gpus?.firstOrNull()
                Column(Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                    Meters((report.pc.cpu.usagePercent ?: 0) / 100.0, (card?.utilizationPercent ?: 0.0) / 100, card?.name, report.pc.memory.usedFraction)
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        Detail("Uptime", duration((report.pc.uptimeHours * 3600).toInt()))
                        report.pc.cpu.model?.let { Detail("CPU", "$it · ${report.pc.cpu.cores} threads") }
                        Detail("Memory", "%.1f of %.1f GB used".format(report.pc.memory.totalGB - report.pc.memory.freeGB, report.pc.memory.totalGB))
                        if (card != null) {
                            Detail("GPU memory", "%.1f of %.1f GB".format(card.memoryUsedMB / 1024, card.memoryTotalMB / 1024))
                            Detail("GPU", "%.0f°C · %.0f W".format(card.temperatureC, card.powerW))
                        } else report.gpu?.takeIf { !it.available }?.let { Detail("GPU", it.error ?: "Not available") }
                        report.pc.disks.forEach { Detail("Disk ${it.drive}", "%.0f GB free of %.0f GB".format(it.freeGB, it.totalGB)) }
                    }
                }
            }
            else -> Text(store.pcStatusError ?: "Reading the PC…", style = HelixType.subheadline, color = HelixColors.textSecondary,
                modifier = Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(Spacing.lg))
        }
    }
}

@Composable
private fun Meters(cpu: Double, gpu: Double, gpuName: String?, memory: Double) {
    AdaptiveRow(Spacing.lg) { m ->
        Meter("CPU", cpu, null, m)
        Meter("GPU", gpu, gpuName, m)
        Meter("Memory", memory, null, m)
    }
}

/** A circular capacity gauge (SwiftUI `.accessoryCircularCapacity`). */
@Composable
private fun Meter(title: String, value: Double, caption: String?, modifier: Modifier) {
    val color = if (value > 0.9) HelixColors.gold else HelixColors.goldMid
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(Modifier.padding(vertical = Spacing.xs).size(66.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(66.dp)) {
                val w = 6.dp.toPx()
                drawCircle(color.copy(alpha = 0.25f), radius = (size.minDimension - w) / 2, style = Stroke(w))
                drawArc(color, -90f, 360f * value.toFloat().coerceIn(0f, 1f), false,
                    topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2), size = androidx.compose.ui.geometry.Size(size.width - w, size.height - w), style = Stroke(w, cap = StrokeCap.Round))
            }
            Text("${(value * 100).toInt()}%", style = HelixType.footnote.semibold.monospacedDigit, color = HelixColors.textPrimary)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
            caption?.let { Text(it, style = HelixType.caption, color = HelixColors.textSecondary, textAlign = TextAlign.Center) }
        }
    }
}

@Composable
private fun Detail(title: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(title, style = HelixType.footnote, color = HelixColors.textSecondary)
        Text(value, style = HelixType.footnote.medium, color = HelixColors.textPrimary, textAlign = TextAlign.End, modifier = Modifier.weight(1f).padding(start = Spacing.md))
    }
}

@Composable
private fun SessionsCard(store: HelixStore, nav: Navigator) {
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SectionHeader("Agent Sessions")
        if (store.isLoadingSessions) ActivityIndicator("Loading sessions…")
        store.sessionsError?.let { error ->
            Text(error, style = HelixType.subheadline, color = HelixColors.textSecondary)
            TextButton("Retry") { scope.launch { store.syncAgentSessions() } }
        }
        if (store.sessions.isNotEmpty()) CardList(store.sessions) { session ->
            Row(
                Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).tappable(store.isPaired) { nav.push(Screen.Chat(store.sessionConversationID(session))) },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(dotColor(session)))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(session.title, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
                    Text(listOfNotNull(if (session.provider == Provider.Claude) "Claude" else "Codex", session.projectName).joinToString(" • "), style = HelixType.footnote, color = HelixColors.textSecondary)
                }
                Text(stateLabel(session), style = HelixType.footnote.medium, color = if (session.liveStatus == LiveStatus.Busy) HelixColors.goldText else HelixColors.textSecondary)
                SymbolIcon(Symbol.ChevronRight, 16.dp, HelixColors.textSecondary)
            }
        }
    }
}

@Composable
private fun WatchersCard(store: HelixStore) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SectionHeader("Watchers")
        if (store.watchers.isEmpty()) {
            Text("No watchers yet. Agents add them when they start a long job.", style = HelixType.subheadline, color = HelixColors.textSecondary,
                modifier = Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(Spacing.lg))
        } else CardList(store.watchers) { watcher ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                    SymbolIcon(if (watcher.severity == Severity.Info) Symbol.Eye else Symbol.WarningFill, 20.dp, if (watcher.severity == Severity.Info) HelixColors.textSecondary else HelixColors.gold)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(watcher.name, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
                    Text(watcher.summary, style = HelixType.footnote, color = HelixColors.textSecondary)
                }
                Text(RelativeTime.short(watcher.lastEventAt), style = HelixType.footnote, color = HelixColors.textSecondary)
            }
        }
    }
}

private fun dotColor(s: AgentSession) = when {
    !s.live -> HelixColors.textMuted.copy(alpha = 0.4f)
    s.liveStatus == LiveStatus.Busy -> HelixColors.gold
    else -> HelixColors.online
}

private fun stateLabel(s: AgentSession) = when {
    !s.live -> "Stopped"
    s.liveStatus == LiveStatus.Busy -> "Working"
    else -> "Idle"
}

private fun duration(seconds: Int): String {
    val days = seconds / 86_400
    val hours = seconds % 86_400 / 3600
    val minutes = seconds % 3600 / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}m"
        else -> "${maxOf(minutes, 0)}m"
    }
}

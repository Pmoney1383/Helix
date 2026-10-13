package app.helix.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.helix.model.Conversation
import app.helix.model.FrontDoor
import app.helix.store.AppTab
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.Screen
import app.helix.ui.components.ActionTile
import app.helix.ui.components.AdaptiveRow
import app.helix.ui.components.AssistantCallCard
import app.helix.ui.components.HelixMark
import app.helix.ui.components.HeroCard
import app.helix.ui.components.RecentRow
import app.helix.ui.components.SectionHeader
import app.helix.ui.components.StatusBarFade
import app.helix.ui.components.StatusPill
import app.helix.ui.components.scaled
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.bold
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.pressable
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable

/** Bottom padding that keeps content clear of the floating tab bar. */
val TabBarClearance = 110.dp

@Composable
fun HomeScreen(store: HelixStore, nav: Navigator) {
    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.statusBars)
                .padding(horizontal = Spacing.screen).padding(bottom = Spacing.xxl + TabBarClearance),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            HomeHeader(store.gateway.isOnline)
            store.heroUpdate?.let { update ->
                HeroCard(
                    update,
                    onOpen = { nav.push(update.conversationID?.let { Screen.Chat(it) } ?: Screen.Status) },
                    onCall = { store.startCall(FrontDoor.Claude) },
                    onHide = { store.heroUpdate = null },
                )
            }
            AdaptiveRow { m ->
                AssistantCallCard(FrontDoor.Claude, m) { store.startCall(FrontDoor.Claude) }
                AssistantCallCard(FrontDoor.Codex, m) { store.startCall(FrontDoor.Codex) }
            }
            AdaptiveRow { m ->
                ActionTile("Check Status", "See system health", Symbol.BarChart, modifier = m.pressable { nav.push(Screen.Status) })
                ActionTile("Approvals", "Review pending items", Symbol.VerifiedUser, badge = store.pendingApprovals.size, modifier = m.pressable { nav.push(Screen.Approvals) })
            }
            RecentSection(store.recentConversations.take(2), onOpen = { nav.push(Screen.Chat(it)) }, onSeeAll = { store.selectedTab = AppTab.Chats })
        }
        StatusBarFade()
    }
}

@Composable
private fun HomeHeader(isOnline: Boolean) {
    Row(Modifier.fillMaxWidth().padding(top = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            HelixMark(scaled(50.dp))
            Column {
                Text("Helix", style = HelixType.largeTitle.bold, color = HelixColors.textPrimary)
                Text("Your AI, under control.", style = HelixType.subheadline, color = HelixColors.textMuted)
            }
        }
        Spacer(Modifier.padding(start = Spacing.sm))
        StatusPill(isOnline)
    }
}

@Composable
private fun RecentSection(conversations: List<Conversation>, onOpen: (String) -> Unit, onSeeAll: () -> Unit) {
    Column(Modifier.padding(top = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SectionHeader("Recent") {
            Row(Modifier.defaultMinSize(minHeight = 44.dp).tappable(onClick = onSeeAll), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text("See all", style = HelixType.subheadline.semibold, color = HelixColors.gold)
                SymbolIcon(Symbol.ChevronRight, 14.dp, HelixColors.gold)
            }
        }
        if (conversations.isEmpty()) {
            Text("Chats with Claude and Astra show up here.", style = HelixType.subheadline, color = HelixColors.textSecondary,
                modifier = Modifier.fillMaxWidth().helixCard().padding(Spacing.lg))
        } else {
            Column(Modifier.fillMaxWidth().helixCard(radius = Radius.tile).padding(horizontal = Spacing.lg, vertical = Spacing.xs)) {
                conversations.forEachIndexed { index, conversation ->
                    Box(Modifier.tappable { onOpen(conversation.id) }) { RecentRow(conversation) }
                    if (index != conversations.lastIndex) HorizontalDivider(thickness = 0.5.dp, color = HelixColors.borderWarm.copy(alpha = 0.6f))
                }
            }
        }
        Spacer(Modifier.height(0.dp))
    }
}

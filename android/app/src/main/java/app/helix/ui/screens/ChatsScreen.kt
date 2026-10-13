package app.helix.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.helix.model.Conversation
import app.helix.model.FrontDoor
import app.helix.model.RelativeTime
import app.helix.store.AppTab
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.Screen
import app.helix.ui.components.ActivityIndicator
import app.helix.ui.components.BrandLogo
import app.helix.ui.components.ContentUnavailable
import app.helix.ui.components.GroupRadius
import app.helix.ui.components.HelixMenu
import app.helix.ui.components.IconTile
import app.helix.ui.components.LargeTitle
import app.helix.ui.components.MenuItem
import app.helix.ui.components.SearchField
import app.helix.ui.components.TextButton
import app.helix.ui.components.rememberNow
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.Tint
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsScreen(store: HelixStore, nav: Navigator) {
    var query by rememberSaveable { mutableStateOf("") }
    var menu by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val source = if (query.isEmpty()) store.visibleConversations else store.recentConversations
    val filtered = if (query.isEmpty()) source else source.filter {
        it.title.contains(query, ignoreCase = true) || it.preview.contains(query, ignoreCase = true)
    }

    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars)) {
        LargeTitle("Chats") {
            Box {
                Box(Modifier.size(44.dp).tappable(store.isPaired) { menu = true }, contentAlignment = Alignment.Center) {
                    SymbolIcon(Symbol.AddCircleFill, 30.dp, if (store.isPaired) Tint else Tint.copy(alpha = 0.4f))
                }
                // "New Claude" / "New Astra": the front-door conversation, always opening fresh.
                HelixMenu(menu, { menu = false }, FrontDoor.entries.map { door ->
                    MenuItem.Custom("New ${door.displayName}", { BrandLogo(door.logo, 20.dp) }) {
                        store.frontDoorConversations.firstOrNull { it.frontDoor == door }?.id?.let { nav.push(Screen.Chat(it)) }
                    }
                })
            }
        }
        SearchField(query, { query = it }, "Search chats")
        Spacer(Modifier.height(Spacing.md))

        if (!store.isPaired) {
            ContentUnavailable(
                Symbol.Desktop, "Pair Your PC", "Pair in Settings to view and continue real Claude and Codex sessions.",
                Modifier.padding(top = 60.dp), action = "Open Settings" to { store.selectedTab = AppTab.Settings },
            )
            return@Column
        }

        PullToRefreshBox(isRefreshing = store.isLoadingSessions, onRefresh = { scope.launch { store.syncAgentSessions() } }, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = TabBarClearance)) {
                if (store.isLoadingSessions) item { Box(Modifier.fillMaxWidth().padding(Spacing.lg), contentAlignment = Alignment.Center) { ActivityIndicator("Loading sessions…") } }
                store.sessionsError?.let { error ->
                    item {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).clip(RoundedCornerShape(GroupRadius)).background(HelixColors.surface).padding(horizontal = 16.dp, vertical = 8.dp)) {
                            Text(error, style = HelixType.subheadline, color = HelixColors.textPrimary)
                            TextButton("Retry") { scope.launch { store.syncAgentSessions() } }
                        }
                    }
                }
                if (filtered.isNotEmpty()) {
                    item { Text(if (query.isEmpty()) "Chats" else "Results", style = HelixType.footnote.semibold, color = HelixColors.textSecondary, modifier = Modifier.padding(start = 32.dp, top = 8.dp, bottom = 6.dp)) }
                    itemsIndexed(filtered, key = { _, c -> c.id }) { index, conversation ->
                        val first = index == 0
                        val last = index == filtered.lastIndex
                        val shape = RoundedCornerShape(
                            topStart = if (first) GroupRadius else 0.dp, topEnd = if (first) GroupRadius else 0.dp,
                            bottomStart = if (last) GroupRadius else 0.dp, bottomEnd = if (last) GroupRadius else 0.dp,
                        )
                        Column(Modifier.padding(horizontal = 16.dp).clip(shape).background(HelixColors.surface).tappable { nav.push(Screen.Chat(conversation.id)) }) {
                            ChatListRow(conversation, conversation.id in store.typingConversationIDs)
                            if (!last) HorizontalDivider(Modifier.padding(start = 72.dp), thickness = 0.5.dp, color = HelixColors.borderWarm)
                        }
                    }
                } else if (query.isNotEmpty()) {
                    item { ContentUnavailable(Symbol.Search, "No Results for \"$query\"", "Check the spelling or try a new search.", Modifier.padding(top = 40.dp)) }
                } else if (!store.isLoadingSessions) {
                    item { ContentUnavailable(Symbol.Forum, "No Chats Yet", "Tap + to start a new conversation with Claude or Astra.", Modifier.padding(top = 40.dp)) }
                }
            }
        }
    }
}

@Composable
private fun ChatListRow(conversation: Conversation, isTyping: Boolean) {
    val now = rememberNow()
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
        IconTile(conversation.icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(conversation.title, style = HelixType.body.semibold, color = HelixColors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.size(Spacing.sm))
                Text(RelativeTime.short(conversation.lastActivityAt, now), style = HelixType.footnote, color = HelixColors.textSecondary)
            }
            Text(
                if (isTyping) "Typing…" else conversation.preview, style = HelixType.subheadline,
                color = if (isTyping) HelixColors.goldText else HelixColors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
        }
        SymbolIcon(Symbol.ChevronRight, 18.dp, HelixColors.textSecondary.copy(alpha = 0.6f))
    }
}

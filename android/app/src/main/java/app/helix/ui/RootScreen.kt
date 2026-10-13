package app.helix.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import app.helix.store.AppTab
import app.helix.store.HelixStore
import app.helix.store.HomeRoute
import app.helix.ui.components.HelixMaterialTheme
import app.helix.ui.components.TabBar
import app.helix.ui.screens.ApprovalsScreen
import app.helix.ui.screens.CallScreen
import app.helix.ui.screens.CallsScreen
import app.helix.ui.screens.ChatDetailScreen
import app.helix.ui.screens.ChatsScreen
import app.helix.ui.screens.HomeScreen
import app.helix.ui.screens.IncomingCallScreen
import app.helix.ui.screens.PetNamesScreen
import app.helix.ui.screens.SettingsScreen
import app.helix.ui.screens.StatusScreen
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable

/** A screen pushed onto a tab (SwiftUI's NavigationStack path). */
sealed interface Screen {
    data object Root : Screen
    data object Status : Screen
    data object Approvals : Screen
    data class Chat(val id: String) : Screen
    data object PetNames : Screen
}

/** One back stack per tab, as each iPhone tab has its own NavigationStack. */
class Navigator(private val store: HelixStore) {
    private val stacks: Map<AppTab, SnapshotStateList<Screen>> = AppTab.entries.associateWith { mutableStateListOf<Screen>(Screen.Root) }
    fun stack(tab: AppTab): List<Screen> = stacks.getValue(tab)
    fun push(screen: Screen) { stacks.getValue(store.selectedTab).add(screen) }
    fun pop(): Boolean {
        val s = stacks.getValue(store.selectedTab)
        if (s.size <= 1) return false
        s.removeAt(s.lastIndex)
        return true
    }
    fun reset(tab: AppTab, to: List<Screen>) {
        val s = stacks.getValue(tab)
        s.clear(); s.add(Screen.Root); s.addAll(to)
    }
}

@Composable
fun RootScreen(store: HelixStore) {
    val nav = remember { Navigator(store) }
    val holder = rememberSaveableStateHolder()

    // A tapped notification asks for a Home screen; Home shows it even on a cold start.
    LaunchedEffect(store.pendingHomeRoute) {
        val route = store.pendingHomeRoute ?: return@LaunchedEffect
        nav.reset(AppTab.Home, listOf(when (route) {
            HomeRoute.Status -> Screen.Status
            HomeRoute.Approvals -> Screen.Approvals
            is HomeRoute.Conversation -> Screen.Chat(route.id)
        }))
        store.pendingHomeRoute = null
    }

    val callShowing = store.activeCall != null && !store.callScreenHidden
    BackHandler(enabled = !callShowing && store.ringing == null && nav.stack(store.selectedTab).size > 1) { nav.pop() }
    BackHandler(enabled = callShowing) { store.callScreenHidden = true }

    HelixMaterialTheme {
        Box(Modifier.fillMaxSize().background(HelixColors.bg)) {
            val tab = store.selectedTab
            val stack = nav.stack(tab)
            val top = stack.last()
            AnimatedContent(
                targetState = tab to top,
                transitionSpec = {
                    if (initialState.first != targetState.first) fadeIn(tween(120)) togetherWith fadeOut(tween(120))
                    else {
                        // Pushed: the old screen is still on the stack, below the new one. Popped: it is gone.
                        val stack = nav.stack(targetState.first)
                        val forward = stack.indexOf(initialState.second) in 0 until stack.indexOf(targetState.second)
                        if (forward) slideInHorizontally(tween(300)) { it } togetherWith slideOutHorizontally(tween(300)) { -it / 3 }
                        else slideInHorizontally(tween(300)) { -it / 3 } togetherWith slideOutHorizontally(tween(300)) { it }
                    }
                },
                label = "nav",
            ) { (t, screen) ->
                holder.SaveableStateProvider("$t/$screen") {
                    when (screen) {
                        Screen.Root -> when (t) {
                            AppTab.Home -> HomeScreen(store, nav)
                            AppTab.Chats -> ChatsScreen(store, nav)
                            AppTab.Calls -> CallsScreen(store)
                            AppTab.Settings -> SettingsScreen(store, nav)
                        }
                        Screen.Status -> StatusScreen(store, nav)
                        Screen.Approvals -> ApprovalsScreen(store, nav)
                        is Screen.Chat -> ChatDetailScreen(store, nav, screen.id)
                        Screen.PetNames -> PetNamesScreen(store, nav)
                    }
                }
            }

            // Inside a chat the composer takes the bottom edge, so the tab bar steps aside.
            if (top !is Screen.Chat) TabBar(
                items = listOf(
                    Triple("Home", Symbol.HomeFill, tab == AppTab.Home),
                    Triple("Chats", Symbol.ChatFill, tab == AppTab.Chats),
                    Triple("Calls", Symbol.CallFill, tab == AppTab.Calls),
                    Triple("Settings", Symbol.SettingsFill, tab == AppTab.Settings),
                ),
                onSelect = { index ->
                    val selected = AppTab.entries[index]
                    // Tapping the current tab again pops to its root, as on the iPhone.
                    if (selected == store.selectedTab) nav.reset(selected, emptyList()) else store.selectedTab = selected
                },
                modifier = Modifier.align(Alignment.BottomCenter),
            )

            // "On a call with … · Tap to return" when the call screen is minimised.
            val call = store.activeCall
            if (call != null && store.callScreenHidden) {
                Row(
                    Modifier.align(Alignment.TopCenter).windowInsetsPadding(WindowInsets.statusBars).padding(top = Spacing.xs)
                        .clip(CircleShape).background(HelixColors.gold).tappable { store.callScreenHidden = false }
                        .padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    SymbolIcon(Symbol.CallFill, 16.dp, HelixColors.onGold)
                    Text("On a call with ${call.title} · Tap to return", style = HelixType.footnote.semibold, color = HelixColors.onGold)
                }
            }

            AnimatedVisibility(callShowing, enter = slideInVertically(tween(320)) { it }, exit = slideOutVertically(tween(280)) { it }) {
                CallScreen(store)
            }
            AnimatedVisibility(store.ringing != null && store.activeCall == null, enter = fadeIn(), exit = fadeOut()) {
                store.ringing?.let { IncomingCallScreen(store, it) }
            }
        }
    }
}

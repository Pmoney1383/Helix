package app.helix.ui.screens

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.StartOffset
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.helix.model.ChatMessage
import app.helix.model.MessageSender
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.components.ActivityIndicator
import app.helix.ui.components.ContentUnavailable
import app.helix.ui.components.DialogButton
import app.helix.ui.components.HelixAlert
import app.helix.ui.components.HelixTextField
import app.helix.ui.components.InlineNavBar
import app.helix.ui.components.TextButton
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(store: HelixStore, nav: Navigator, conversationID: String) {
    val conversation = store.conversation(conversationID)
    Column(Modifier.fillMaxSize().background(HelixColors.bg)) {
        InlineNavBar(conversation?.title ?: "", onBack = { nav.pop() })
        if (conversation == null) {
            ContentUnavailable(Symbol.Chat, "Chat Not Found", "This conversation is no longer on the PC.", Modifier.padding(top = 80.dp))
            return@Column
        }
        var draft by rememberSaveable(conversationID) { mutableStateOf("") }
        val scope = rememberCoroutineScope()
        val listState = rememberLazyListState()
        val isTyping = conversation.id in store.typingConversationIDs
        val streaming = store.streamingReplies[conversation.id]

        LaunchedEffect(conversation.id) {
            // "Start Here" is a fresh conversation every visit; a real session loads its whole transcript.
            if (conversation.frontDoor != null) store.resetFrontDoorConversation(conversation.id) else store.loadConversation(conversation.id)
            // HTTP recovery: also catches replies produced while the app was in the background.
            while (isActive) {
                delay(4_000)
                if (conversation.id in store.typingConversationIDs) store.loadConversation(conversation.id)
            }
        }
        val count = conversation.messages.size + (if (streaming.isNullOrEmpty()) 0 else 1) + (if (isTyping) 1 else 0)
        LaunchedEffect(count, streaming?.length) { if (count > 0) listState.animateScrollToItem(count + 1) }

        PullToRefreshBox(
            isRefreshing = conversation.id in store.loadingConversationIDs,
            onRefresh = { scope.launch { store.loadConversation(conversation.id) } },
            modifier = Modifier.weight(1f),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = Spacing.lg, vertical = Spacing.md),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                if (conversation.id in store.hasMoreHistory) item {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        TextButton("Load Earlier Messages", enabled = conversation.id !in store.loadingConversationIDs) {
                            scope.launch { store.loadConversation(conversation.id, older = true) }
                        }
                    }
                }
                if (conversation.id in store.loadingConversationIDs) item {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { ActivityIndicator("Loading history…") }
                }
                items(conversation.messages, key = { it.id }) { MessageView(it) }
                if (!streaming.isNullOrEmpty()) item(key = "stream") {
                    MessageView(ChatMessage("stream", MessageSender.Agent, streaming, Instant.now()))
                } else if (isTyping) item(key = "typing") { TypingIndicator() }
                item { Box(Modifier.size(1.dp)) }
            }
        }

        Column(Modifier.background(HelixColors.bg).windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            store.chatNotices[conversation.id]?.let { EventLine(it, Symbol.Branch, Modifier.padding(horizontal = Spacing.lg)) }
            store.chatErrors[conversation.id]?.let { error ->
                Column(Modifier.padding(horizontal = Spacing.lg).fillMaxWidth().helixCard().padding(Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SymbolIcon(Symbol.Warning, 18.dp, HelixColors.textPrimary)
                        Text(error, style = HelixType.subheadline, color = HelixColors.textPrimary)
                    }
                    TextButton("Refresh Chat") { scope.launch { store.loadConversation(conversation.id) } }
                }
            }
            Composer(
                draft = draft, onDraft = { draft = it },
                placeholder = "Message ${conversation.frontDoor?.displayName ?: conversation.title}",
                enabled = store.canSend(conversation.id),
                sending = conversation.id in store.sendingConversationIDs,
            ) {
                // Clear at once, and put the text back only if the send failed.
                val submitted = draft
                draft = ""
                scope.launch { if (!store.send(submitted, conversation.id)) draft = submitted }
            }
        }

        val prompt = store.heavySessionPrompt
        if (prompt != null && prompt.conversationID == conversation.id) {
            HelixAlert(
                "Large Session",
                "This session is about ${prompt.contextTokens / 1000}k tokens. Continuing will use a lot of your usage.",
                buildList {
                    if (conversation.frontDoor != null) add(DialogButton("Start Fresh") { scope.launch { store.startFreshAndSend() } })
                    add(DialogButton("Continue Anyway") { scope.launch { store.confirmHeavySend() } })
                    add(DialogButton("Cancel", DialogButton.Role.Cancel) { draft = prompt.text; store.dismissHeavySessionPrompt() })
                },
                onDismiss = { store.dismissHeavySessionPrompt() },
            )
        }
    }
}

@Composable
private fun MessageView(message: ChatMessage) {
    when {
        message.sender == MessageSender.User && message.isWatcherEvent ->
            EventLine(message.text.replace("[Helix watcher]", "").trim(), Symbol.BellBadge)
        message.sender == MessageSender.User -> Bubble(message.text, trailing = true, fill = HelixColors.surfaceWarm, border = HelixColors.goldMid.copy(alpha = 0.45f))
        message.sender == MessageSender.Agent -> Bubble(message.text, trailing = false, fill = HelixColors.surface, border = HelixColors.borderWarm)
        else -> EventLine(message.text, Symbol.Branch)
    }
}

@Composable
private fun Bubble(text: String, trailing: Boolean, fill: Color, border: Color) {
    Box(Modifier.fillMaxWidth().padding(start = if (trailing) 40.dp else 0.dp, end = if (trailing) 0.dp else 40.dp), contentAlignment = if (trailing) Alignment.CenterEnd else Alignment.CenterStart) {
        Box(Modifier.widthIn(max = 520.dp).helixCard(fill, border, 20.dp).padding(horizontal = 14.dp, vertical = 10.dp)) {
            MessageContent(text)
        }
    }
}

/**
 * Renders a message like Claude and ChatGPT do: fenced ``` code blocks become a monospaced card (horizontally scrollable,
 * with the language label), plain text renders inline Markdown (bold, italic, `code`, links). A streaming reply that ends
 * inside a fence shows an open code block instead of a stray "```".
 */
@Composable
private fun MessageContent(text: String) {
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (segment in remember(text) { segments(text) }) {
                if (segment.isCode) CodeBlock(segment.language, segment.text)
                else if (segment.text.isNotEmpty()) Text(remember(segment.text) { inlineMarkdown(segment.text) }, style = HelixType.body, color = HelixColors.textPrimary)
            }
        }
    }
}

private data class Segment(val isCode: Boolean, val language: String?, val text: String)

private fun segments(text: String): List<Segment> {
    val result = mutableListOf<Segment>()
    var rest = text
    while (true) {
        val fence = rest.indexOf("```")
        if (fence < 0) break
        val before = rest.substring(0, fence)
        if (before.isNotEmpty()) result += Segment(false, null, before)
        val after = rest.substring(fence + 3)
        val lineEnd = after.indexOf('\n').let { if (it < 0) after.length else it }
        val language = after.substring(0, lineEnd).trim().ifEmpty { null }
        val body = if (lineEnd == after.length) "" else after.substring(lineEnd + 1)
        val close = body.indexOf("```")
        if (close >= 0) {
            result += Segment(true, language, body.substring(0, close))
            rest = body.substring(close + 3)
        } else {
            result += Segment(true, language, body) // still streaming
            rest = ""
        }
    }
    if (rest.isNotEmpty()) result += Segment(false, null, rest)
    return result
}

/** SwiftUI's inline-only Markdown: **bold**, *italic* / _italic_, `code` and [links](url); whitespace is kept. */
private fun inlineMarkdown(source: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < source.length) {
        when {
            source.startsWith("**", i) && source.indexOf("**", i + 2) > i + 2 -> {
                val end = source.indexOf("**", i + 2)
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(source.substring(i + 2, end)) }
                i = end + 2
            }
            source[i] == '`' && source.indexOf('`', i + 1) > i + 1 -> {
                val end = source.indexOf('`', i + 1)
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color.White.copy(alpha = 0.08f))) { append(source.substring(i + 1, end)) }
                i = end + 1
            }
            (source[i] == '*' || source[i] == '_') && i + 1 < source.length && !source[i + 1].isWhitespace() && source.indexOf(source[i], i + 1) > i + 1 -> {
                val end = source.indexOf(source[i], i + 1)
                withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(source.substring(i + 1, end)) }
                i = end + 1
            }
            source[i] == '[' -> {
                val close = source.indexOf(']', i)
                if (close > i && close + 1 < source.length && source[close + 1] == '(' && source.indexOf(')', close) > close) {
                    val urlEnd = source.indexOf(')', close)
                    val url = source.substring(close + 2, urlEnd)
                    pushLink(androidx.compose.ui.text.LinkAnnotation.Url(url, androidx.compose.ui.text.TextLinkStyles(SpanStyle(color = HelixColors.gold, textDecoration = TextDecoration.None))))
                    append(source.substring(i + 1, close))
                    pop()
                    i = urlEnd + 1
                } else { append(source[i]); i++ }
            }
            else -> { append(source[i]); i++ }
        }
    }
}

@Composable
private fun CodeBlock(language: String?, code: String) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(HelixColors.bg).border(1.dp, HelixColors.borderWarm, RoundedCornerShape(10.dp)).padding(bottom = 2.dp)) {
        language?.let { Text(it.uppercase(), style = HelixType.caption2.semibold, color = HelixColors.textSecondary, modifier = Modifier.padding(start = 12.dp, top = 8.dp)) }
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            Text(
                code.trim('\n'), style = HelixType.footnote.copy(fontFamily = FontFamily.Monospace, letterSpacing = androidx.compose.ui.unit.TextUnit.Unspecified),
                color = HelixColors.textPrimary, softWrap = false,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = if (language == null) 10.dp else 6.dp),
            )
        }
    }
}

@Composable
private fun EventLine(text: String, symbol: Symbol, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(
            Modifier.clip(CircleShape).background(HelixColors.surface).padding(horizontal = Spacing.md, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            SymbolIcon(symbol, 15.dp, HelixColors.textSecondary)
            Text(text, style = HelixType.footnote, color = HelixColors.textSecondary)
        }
    }
}

@Composable
private fun TypingIndicator() {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(Modifier.helixCard(radius = 20.dp).padding(14.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(3) { index ->
            val a by transition.animateFloat(0.35f, 1f, infiniteRepeatable(tween(500, easing = EaseInOut), RepeatMode.Reverse, StartOffset(index * 150)), label = "dot$index")
            Box(Modifier.size(7.dp).alpha(a).clip(CircleShape).background(HelixColors.textSecondary))
        }
    }
}

@Composable
private fun Composer(draft: String, onDraft: (String) -> Unit, placeholder: String, enabled: Boolean, sending: Boolean, onSend: () -> Unit) {
    val canSend = enabled && draft.isNotBlank()
    Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.sm), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Box(
            Modifier.weight(1f).defaultMinSize(minHeight = 44.dp).clip(RoundedCornerShape(22.dp)).background(Color(0xFF1C1C1E))
                .border(0.5.dp, Color.White.copy(alpha = 0.08f), RoundedCornerShape(22.dp)).padding(horizontal = Spacing.lg, vertical = 11.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            HelixTextField(draft, onDraft, placeholder, Modifier.fillMaxWidth().heightIn(max = 130.dp), singleLine = false, maxLines = 5, imeAction = ImeAction.Default)
        }
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(if (canSend) HelixColors.gold else HelixColors.surfaceSecondary).tappable(canSend, onSend),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) ActivityIndicator(size = 18.dp) else SymbolIcon(Symbol.ArrowUp, 22.dp, if (canSend) HelixColors.onGold else HelixColors.textSecondary)
        }
    }
}

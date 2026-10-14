package app.helix.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.helix.model.Approval
import app.helix.model.ApprovalStatus
import app.helix.model.DurationText
import app.helix.model.RelativeTime
import app.helix.model.TileIcon
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.components.ActionSheet
import app.helix.ui.components.AdaptiveRow
import app.helix.ui.components.CardList
import app.helix.ui.components.ContentUnavailable
import app.helix.ui.components.DialogButton
import app.helix.ui.components.IconTile
import app.helix.ui.components.InlineNavBar
import app.helix.ui.components.LargeTitle
import app.helix.ui.components.SectionHeader
import app.helix.ui.components.rememberNow
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixGradients
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Radius
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.medium
import app.helix.ui.theme.monospacedDigit
import app.helix.ui.theme.pressable
import app.helix.ui.theme.semibold

@Composable
fun ApprovalsScreen(store: HelixStore, nav: Navigator) {
    var confirming by remember { mutableStateOf<Approval?>(null) }
    val haptics = LocalHapticFeedback.current
    Column(Modifier.fillMaxSize().background(HelixColors.bg)) {
        InlineNavBar("", onBack = { nav.pop() })
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = TabBarClearance)) {
            LargeTitle("Approvals")
            Column(Modifier.padding(horizontal = Spacing.screen, vertical = Spacing.md).animateContentSize(), verticalArrangement = Arrangement.spacedBy(Spacing.xl)) {
                val pending = store.pendingApprovals
                if (pending.isEmpty()) {
                    ContentUnavailable(Symbol.VerifiedUser, "Nothing to Approve", "When an agent wants to delete something, it waits here for you.", Modifier.padding(top = Spacing.xxl))
                } else {
                    pending.forEach { approval ->
                        ApprovalCard(approval, onApprove = { confirming = approval }, onReject = {
                            store.reject(approval.id)
                            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        })
                    }
                }
                val resolved = store.resolvedApprovals
                if (resolved.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                        SectionHeader("History")
                        CardList(resolved) { approval ->
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                                SymbolIcon(
                                    if (approval.status == ApprovalStatus.Approved) Symbol.CheckCircleFill else Symbol.XCircleFill, 22.dp,
                                    if (approval.status == ApprovalStatus.Approved) HelixColors.online else HelixColors.textSecondary,
                                )
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(approval.summary, style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
                                    Text("${approval.status.label} • ${RelativeTime.short(approval.resolvedAt ?: approval.createdAt)}", style = HelixType.footnote, color = HelixColors.textSecondary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    confirming?.let { approval ->
        ActionSheet(
            "Allow ${approval.sessionTitle ?: "the agent"} to continue?",
            "${approval.summary}. This can't be undone.",
            buildList {
                add(DialogButton("Approve", DialogButton.Role.Destructive) {
                    store.approveWithAuth(approval.id)
                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                })
                // A hosted chat messaging an agent: optionally trust that chat with that session for a while.
                val max = approval.trustMaxMinutes
                if (max != null) {
                    for ((minutes, label) in listOf(30 to "30 min", 120 to "2 h", 480 to "8 h")) {
                        if (minutes > max) continue
                        add(DialogButton("Approve & trust $label", DialogButton.Role.Destructive) {
                            store.approveWithAuth(approval.id, trustForMin = minutes)
                            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        })
                    }
                }
                add(DialogButton("Cancel", DialogButton.Role.Cancel) {})
            },
            onDismiss = { confirming = null },
        )
    }
}

@Composable
private fun ApprovalCard(approval: Approval, onApprove: () -> Unit, onReject: () -> Unit) {
    val now = rememberNow(30_000)
    Column(
        Modifier.fillMaxWidth().helixCard(HelixColors.surface, HelixColors.goldMid.copy(alpha = 0.45f), Radius.tile).padding(Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            IconTile(TileIcon.Sym(Symbol.Trash))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(approval.sessionTitle ?: "Agent", style = HelixType.subheadline.semibold, color = HelixColors.textPrimary)
                Text(approval.tool, style = HelixType.footnote.copy(fontFamily = FontFamily.Monospace), color = HelixColors.textSecondary)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                SymbolIcon(Symbol.Timer, 15.dp, HelixColors.goldText)
                Text(DurationText.short(DurationText.between(now, approval.expiresAt)), style = HelixType.footnote.medium.monospacedDigit, color = HelixColors.goldText)
            }
        }
        Text(approval.summary, style = HelixType.headline, color = HelixColors.textPrimary)
        if (approval.reasons.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                approval.reasons.forEach { reason ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        SymbolIcon(Symbol.ExclamationCircle, 15.dp, HelixColors.textSecondary)
                        Text(reason, style = HelixType.footnote, color = HelixColors.textSecondary)
                    }
                }
            }
        }
        Box(Modifier.padding(top = Spacing.xs)) {
            AdaptiveRow { m ->
                Box(
                    m.defaultMinSize(minHeight = 48.dp).clip(CircleShape).background(HelixColors.surfaceSecondary).border(1.dp, HelixColors.borderWarm, CircleShape).pressable(CircleShape, onClick = onReject),
                    contentAlignment = Alignment.Center,
                ) { Text("Reject", style = HelixType.headline, color = HelixColors.textPrimary) }
                Box(
                    m.defaultMinSize(minHeight = 48.dp).clip(CircleShape).background(HelixGradients.callClaude).pressable(CircleShape, onClick = onApprove),
                    contentAlignment = Alignment.Center,
                ) { Text("Approve", style = HelixType.headline, color = HelixColors.onGold) }
            }
        }
    }
}

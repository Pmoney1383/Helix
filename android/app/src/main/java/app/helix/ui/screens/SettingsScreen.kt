package app.helix.ui.screens

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.helix.BuildConfig
import app.helix.MainActivity
import app.helix.R
import app.helix.model.FrontDoor
import app.helix.model.PersonaMode
import app.helix.model.PresenceMode
import app.helix.store.HelixStore
import app.helix.ui.Navigator
import app.helix.ui.Screen
import app.helix.ui.components.ActivityIndicator
import app.helix.ui.components.FormRow
import app.helix.ui.components.FormSection
import app.helix.ui.components.HelixMark
import app.helix.ui.components.HelixMenu
import app.helix.ui.components.HelixTextField
import app.helix.ui.components.InlineNavBar
import app.helix.ui.components.IosSlider
import app.helix.ui.components.LabeledRow
import app.helix.ui.components.LargeTitle
import app.helix.ui.components.MenuItem
import app.helix.ui.components.SegmentedControl
import app.helix.ui.components.SwitchRow
import app.helix.ui.components.TextButton
import app.helix.ui.theme.HelixColors
import app.helix.ui.theme.HelixType
import app.helix.ui.theme.Spacing
import app.helix.ui.theme.Symbol
import app.helix.ui.theme.SymbolIcon
import app.helix.ui.theme.Tint
import app.helix.ui.theme.helixCard
import app.helix.ui.theme.medium
import app.helix.ui.theme.semibold
import app.helix.ui.theme.tappable
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(store: HelixStore, nav: Navigator) {
    var pairing by rememberSaveable { mutableStateOf(false) }
    var modeMenu by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val signingLabel = store.signingStatus?.let { if (it.enrolled) "On" else "Off" } ?: if (store.signingProblem == null) "Checking…" else "Off"

    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars).verticalScroll(rememberScrollState()).padding(bottom = TabBarClearance), verticalArrangement = Arrangement.spacedBy(Spacing.xxl)) {
        LargeTitle("Settings")

        FormSection(header = "Gateway") {
            FormRow {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                    HelixMark(36.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(store.gateway.hostName, style = HelixType.body.semibold, color = HelixColors.textPrimary)
                        Text(store.gateway.address, style = HelixType.footnote, color = HelixColors.textSecondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    }
                    Text(if (store.gateway.isOnline) "Online" else "Offline", style = HelixType.footnote.medium, color = if (store.gateway.isOnline) HelixColors.online else HelixColors.textSecondary)
                }
            }
            LabeledRow("Request signing", trailing = {
                Text(signingLabel, style = HelixType.footnote.medium, color = if (store.signingStatus?.enrolled == true) HelixColors.online else HelixColors.textSecondary)
            })
            store.signingProblem?.let { FormRow { Text(it, style = HelixType.footnote, color = HelixColors.textSecondary) } }
            FormRow(onClick = { pairing = true }, divider = false) { Text("Pair Again…", style = HelixType.body, color = Tint) }
        }

        FormSection(header = "Phone Alerts", footer = store.presence.explanation, background = androidx.compose.ui.graphics.Color.Transparent) {
            SegmentedControl(PresenceMode.entries.map { it.label }, PresenceMode.entries.indexOf(store.presence), { store.changePresence(PresenceMode.entries[it]) })
        }

        FormSection(header = "Voice Personality", footer = "Personality only changes how replies sound. Urgent alerts and approvals are always plain and direct.") {
            SwitchRow("Personality", store.persona.enabled, { store.persona = store.persona.copy(enabled = it) })
            Box {
                LabeledRow("Mode", store.persona.mode.label, valueColor = if (store.persona.enabled) HelixColors.textSecondary else HelixColors.textSecondary.copy(alpha = 0.4f), onClick = { if (store.persona.enabled) modeMenu = true }, trailing = {
                    SymbolIcon(Symbol.ChevronDown, 16.dp, HelixColors.textSecondary)
                })
                HelixMenu(modeMenu, { modeMenu = false }, PersonaMode.entries.map { mode -> MenuItem(mode.label, null) { store.persona = store.persona.applying(mode) } })
            }
            PersonaSlider("Teasing", store.persona.teasing, store.persona.enabled) { store.persona = store.persona.copy(teasing = it) }
            PersonaSlider("Flirtiness", store.persona.flirtiness, store.persona.enabled) { store.persona = store.persona.copy(flirtiness = it) }
            PersonaSlider("Sarcasm", store.persona.sarcasm, store.persona.enabled) { store.persona = store.persona.copy(sarcasm = it) }
            PersonaSlider("Verbosity", store.persona.verbosity, store.persona.enabled) { store.persona = store.persona.copy(verbosity = it) }
            LabeledRow("Pet Names", "${store.persona.petNames.size}", chevron = true, divider = false, onClick = { nav.push(Screen.PetNames) })
        }

        FormSection(header = "Speech", footer = "The PC voice needs the GPU. When it's busy, Helix falls back to the phone's voice.") {
            FormRow {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    Text("Speaking Rate", style = HelixType.body, color = HelixColors.textPrimary)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        SymbolIcon(Symbol.Slower, 20.dp, HelixColors.textSecondary)
                        IosSlider(store.persona.speechRate.toFloat(), { store.persona = store.persona.copy(speechRate = it.toDouble()) }, modifier = Modifier.weight(1f))
                        SymbolIcon(Symbol.Faster, 20.dp, HelixColors.textSecondary)
                    }
                }
            }
            SwitchRow("Use PC Voice When Available", store.persona.usePCVoice, { store.persona = store.persona.copy(usePCVoice = it) }, divider = false)
        }

        // The iPhone has "Add to Siri" here. Android's equivalent is a home-screen shortcut that starts the call.
        FormSection(header = "Shortcuts", footer = "Long-press the Helix icon for these too, or add one to your home screen.") {
            FrontDoor.entries.forEachIndexed { index, door ->
                LabeledRow("Call ${door.displayName}", divider = index == 0, trailing = {
                    Text("Add to Home Screen", style = HelixType.subheadline, color = Tint, modifier = Modifier.tappable { pinCallShortcut(context, door) })
                })
            }
        }

        AndroidSection(context)

        FormSection(header = "About") {
            LabeledRow("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", divider = false)
        }
    }

    if (pairing) PairingSheet(store) { pairing = false }
}

/** Android only: what keeps alerts and calls arriving while the app is closed. */
@Composable
private fun AndroidSection(context: Context) {
    var tick by remember { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) tick++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val notifications = remember(tick) {
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }
    val unrestricted = remember(tick) { context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName) }
    val microphone = remember(tick) { ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { tick++ }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { tick++ }

    FormSection(header = "Background", footer = "Helix keeps a connection to your PC open (the small \"Connected\" notification) so alerts and calls reach you. Unrestricted battery use keeps Android from closing it.") {
        LabeledRow("Notifications", if (notifications) "On" else "Off", onClick = if (notifications) null else ({ if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) }))
        LabeledRow("Microphone", if (microphone) "Allowed" else "Ask", onClick = if (microphone) null else ({ askMic.launch(Manifest.permission.RECORD_AUDIO) }))
        LabeledRow("Battery", if (unrestricted) "Unrestricted" else "Optimized", chevron = !unrestricted, divider = false, onClick = if (unrestricted) null else ({
            context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
        }))
    }
}

private fun pinCallShortcut(context: Context, door: FrontDoor) {
    val manager = context.getSystemService(ShortcutManager::class.java) ?: return
    val shortcut = ShortcutInfo.Builder(context, "call-${door.name.lowercase()}")
        .setShortLabel("Call ${door.displayName}")
        .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
        .setIntent(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_CALL, door.name))
        .build()
    if (manager.isRequestPinShortcutSupported) manager.requestPinShortcut(shortcut, null)
}

@Composable
private fun PersonaSlider(title: String, value: Double, enabled: Boolean, onChange: (Double) -> Unit) {
    FormRow {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Row {
                Text(title, style = HelixType.body, color = HelixColors.textPrimary.copy(alpha = if (enabled) 1f else 0.4f), modifier = Modifier.weight(1f))
                Text("${(value * 100).toInt()}%", style = HelixType.body, color = HelixColors.textSecondary.copy(alpha = if (enabled) 1f else 0.4f))
            }
            IosSlider(value.toFloat(), { onChange(it.toDouble()) }, enabled)
        }
    }
}

@Composable
fun PetNamesScreen(store: HelixStore, nav: Navigator) {
    var editing by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    val names = store.persona.petNames
    val trimmed = newName.trim()
    val canAdd = trimmed.length in 2..20 && trimmed.all { it.isLetter() } && names.size < 12
    fun add() { if (canAdd) { store.persona = store.persona.copy(petNames = names + trimmed); newName = "" } }

    Column(Modifier.fillMaxSize().background(HelixColors.bg)) {
        InlineNavBar("Pet Names", onBack = { nav.pop() }) {
            Text(if (editing) "Done" else "Edit", style = HelixType.body.copy(fontWeight = if (editing) FontWeight.SemiBold else FontWeight.Normal), color = Tint, modifier = Modifier.tappable { editing = !editing }.padding(8.dp))
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xxl)) {
            FormSection(footer = "Flirty mode picks one of these now and then. Keep 1 to 12 names, letters only.") {
                names.forEachIndexed { index, name ->
                    FormRow(divider = index != names.lastIndex) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                            AnimatedVisibility(editing && names.size > 1) {
                                Box(Modifier.size(22.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color(0xFFFF453A)).tappable {
                                    store.persona = store.persona.copy(petNames = names.filterIndexed { i, _ -> i != index })
                                }, contentAlignment = Alignment.Center) {
                                    Box(Modifier.size(width = 10.dp, height = 2.dp).background(androidx.compose.ui.graphics.Color.White))
                                }
                            }
                            Text(name, style = HelixType.body, color = HelixColors.textPrimary)
                        }
                    }
                }
            }
            FormSection {
                FormRow(divider = false) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        HelixTextField(newName, { newName = it }, "Add a name", Modifier.weight(1f), autoCapitalize = false, imeAction = ImeAction.Done, onSubmit = ::add)
                        TextButton("Add", enabled = canAdd) { add() }
                    }
                }
            }
        }
    }
}

/** The pairing sheet: the code from `npm run pair` and the gateway's address. */
@Composable
private fun PairingSheet(store: HelixStore, onDismiss: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf(store.session.baseUrl) }
    var showAddress by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val valid = code.trim().length >= 4 && address.trim().lowercase().startsWith("http")
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Dialog(onDismissRequest = { if (!store.isPairing) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().tappable { if (!store.isPairing) onDismiss() }, contentAlignment = Alignment.BottomCenter) {
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 38.dp, topEnd = 38.dp)).background(HelixColors.bg).tappable { }
                    .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
            ) {
                Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp)) {
                    Text("Cancel", style = HelixType.body, color = if (store.isPairing) HelixColors.textSecondary else Tint, modifier = Modifier.align(Alignment.CenterStart).tappable(!store.isPairing, onDismiss).padding(8.dp))
                    Text("Pair with Your PC", style = HelixType.headline, color = HelixColors.textPrimary, modifier = Modifier.align(Alignment.Center))
                    Box(Modifier.align(Alignment.CenterEnd)) {
                        if (store.isPairing) ActivityIndicator(size = 20.dp)
                        else Text("Pair", style = HelixType.body.copy(fontWeight = FontWeight.SemiBold), color = if (valid) Tint else HelixColors.textSecondary.copy(alpha = 0.5f),
                            modifier = Modifier.tappable(valid) {
                                scope.launch {
                                    store.pair(code, Build.MODEL ?: "Android", address.trim())
                                    if (store.isPaired && store.pairingErrorMessage == null) onDismiss()
                                }
                            }.padding(8.dp))
                    }
                }
                Column(Modifier.padding(Spacing.screen), verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                    Text(buildAnnotatedString {
                        append("On the PC, run ")
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("npm run pair") }
                        append(" in the gateway folder, then enter the code it shows.")
                    }, style = HelixType.subheadline, color = HelixColors.textSecondary)
                    Box(Modifier.fillMaxWidth().helixCard(radius = 16.dp).padding(Spacing.lg)) {
                        HelixTextField(code, { code = it.uppercase() }, "Pairing code", Modifier.fillMaxWidth().focusRequester(focus),
                            style = HelixType.title2.copy(fontFamily = FontFamily.Monospace), enabled = !store.isPairing, capitalizeCharacters = true)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        Row(Modifier.tappable { showAddress = !showAddress }, verticalAlignment = Alignment.CenterVertically) {
                            Text("Gateway Address", style = HelixType.footnote, color = HelixColors.textSecondary, modifier = Modifier.weight(1f))
                            SymbolIcon(if (showAddress) Symbol.ChevronDown else Symbol.ChevronRight, 16.dp, HelixColors.textSecondary)
                        }
                        AnimatedVisibility(showAddress) {
                            HelixTextField(address, { address = it }, "https://your-pc.tailnet.ts.net", Modifier.fillMaxWidth().padding(top = Spacing.xs),
                                style = HelixType.footnote.copy(fontFamily = FontFamily.Monospace), enabled = !store.isPairing, keyboardType = KeyboardType.Uri)
                        }
                    }
                    store.pairingErrorMessage?.let { Text(it, style = HelixType.footnote, color = androidx.compose.ui.graphics.Color(0xFFFF453A)) }
                    Spacer(Modifier.height(160.dp))
                }
            }
        }
    }
}


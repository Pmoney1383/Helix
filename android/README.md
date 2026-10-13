# Helix for Android

The Android twin of the iPhone app: the same screens (Home, Chats, Calls, Settings, Status, Approvals, the call screen),
the same gold-on-black design and the same behaviour, written in Kotlin with Jetpack Compose. Each screen is a
translation of its SwiftUI file in `ios/Helix/`, and the colours come from the same `design/tokens.json`.

Unlike the iPhone, Android needs **no developer account and no push key**. Notifications and incoming calls reach
the phone over the app's own live connection to your gateway (see [How alerts and calls arrive](#how-alerts-and-calls-arrive)).

## Build and run

You need [Android Studio](https://developer.android.com/studio) (it brings the JDK and the Android SDK) and a phone
on Android 8.0 or newer, or an emulator.

1. In Android Studio: **File > Open** and pick the `android/` folder. Let Gradle sync.
2. Optional: create `android/local.properties` (gitignored; Android Studio adds `sdk.dir` itself) with your values:

   ```properties
   helix.applicationId=com.yourname.helix
   helix.gatewayHost=my-pc.my-tailnet.ts.net
   ```

   `helix.applicationId` defaults to `com.example.helix`. `helix.gatewayHost` pre-fills the pairing sheet.
3. Pick a device and press **Run**. Or from a terminal: `gradlew assembleDebug` (the APK is in
   `app/build/outputs/apk/debug/`), and `gradlew testDebugUnitTest` for the unit tests.

Before pairing, the app shows sample data so you can look around, as the iPhone app does.

## Pair

1. On the PC, in `pc-gateway/`: `npm run pair`.
2. In the app: **Settings > Pair Again…**, enter the code, open **Gateway Address** and enter
   `https://<pc>.<tailnet>.ts.net` (your Tailscale Serve address, as for the iPhone).

The phone needs the Tailscale app, signed in to the same tailnet. Pairing creates a signing key in the Android Keystore
(in StrongBox when the phone has one); **Settings > Gateway > Request signing** shows **On** once the gateway has it.
See [docs/DEVICE-SIGNING.md](../docs/DEVICE-SIGNING.md).

**Emulator on the same PC:** debug builds may also use plain HTTP to the PC itself, which the emulator sees as
`10.0.2.2`. Pair with `http://10.0.2.2:7777` (the gateway's port); no Tailscale is needed. Release builds always require HTTPS.

## How alerts and calls arrive

There is no Google Firebase here, and no cloud in between. After pairing, a small **foreground service** keeps the
WebSocket to your gateway open and shows one quiet "Connected to your PC" notification. Through that connection:

- an important or critical event, or an approval request, becomes an Android notification (the gateway sends a
  `device.notification` event, the same thing an iPhone receives as an Apple push);
- approval notifications have **Approve** (opens the app and asks for your fingerprint, face or screen lock first) and
  **Reject**;
- an incoming call (`call.ringing`) rings through Android's own call system, full screen on a locked phone, so
  Bluetooth headsets and car kits can answer it.

The gateway counts a push or a ring as delivered only while an Android phone is actually connected; otherwise it is
recorded as unavailable, exactly as for an iPhone without a push key. Things that keep the connection alive:

- **Settings > Background** in the app: allow notifications, the microphone (for calls) and unrestricted battery use.
  Some phone makers close background apps aggressively; unrestricted battery use is what stops that.
- The service starts again after a reboot and after an app update.

## Differences from the iPhone app

| iPhone | Android |
|---|---|
| Apple push and PushKit (needs a paid account and your `.p8` key) | The live connection; nothing to set up |
| CallKit | Android's call system (a self-managed call), with an in-app ring screen when the app is open |
| Face ID / passcode before approving | Fingerprint, face or screen lock (BiometricPrompt) |
| Secure Enclave signing key | Android Keystore key, in StrongBox when available |
| Apple speech recognition and voice | Android's speech recognizer and text-to-speech; the PC voice plays the same raw audio |
| Siri ("Call Claude") | Long-press the app icon, or **Settings > Shortcuts > Add to Home Screen** |
| CarPlay | Not yet (Android Auto is a possible follow-up) |
| SF Symbols, SF Pro | Material Symbols Rounded, Inter |

Known limits:

- **Barge-in** (talking over a reply) needs two or more words on Android: the speech recognizer does not get the
  iPhone's echo cancellation reference, so a single stray syllable of the phone's own voice must not cut a reply off.
- The **personality screen** changes settings on the phone only, as on the iPhone ([docs/PERSONA.md](../docs/PERSONA.md)).
- The emulator has no real microphone input in most setups, so spoken replies and spoken approvals are best tried on a phone.

## Layout

| Path | What |
|---|---|
| `app/src/main/java/app/helix/model/` | UI and wire models, the event decoder, sample data, time formatting |
| `app/src/main/java/app/helix/gateway/` | REST client, WebSocket, session, encrypted storage, the signing key |
| `app/src/main/java/app/helix/store/HelixStore.kt` | App state and logic (the iPhone's `HelixStore.swift`, function for function) |
| `app/src/main/java/app/helix/call/` | Calls: Android's call system, the voice loop, spoken approvals, ringback |
| `app/src/main/java/app/helix/service/` | The foreground service, notifications, boot and notification-action receivers |
| `app/src/main/java/app/helix/ui/` | Theme, components (hero artwork, call cards, iOS-style controls) and screens |
| `scripts/` | `generate-tokens.mjs` (colours from `design/tokens.json`), `symbols.mjs` (icons), `make-icons.ps1` (launcher icon) |

## Licenses of bundled assets

- **Inter** (fonts in `app/src/main/res/font/`): SIL Open Font License 1.1, see [licenses/Inter-OFL.txt](licenses/Inter-OFL.txt).
- **Material Symbols** (path data in `SymbolPaths.kt`): Apache License 2.0, from
  [google/material-design-icons](https://github.com/google/material-design-icons).
- The Claude and OpenAI marks belong to their owners and are used only to label which assistant you are calling.

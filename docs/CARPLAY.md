# CarPlay (voice-based conversation)

Code: `ios/Helix/CarPlay/CarPlaySceneDelegate.swift`. Scene registered in `ios/Helix/Config/HelixApp-Info.plist`
(`CPTemplateApplicationSceneSessionRoleApplication`, configuration `Helix-CarPlay`).

## Turning it on: Apple must grant you the entitlement

CarPlay apps need the `com.apple.developer.carplay-voice-based-conversation` entitlement. It is a **managed
capability**: Apple grants it per developer and per App ID, on request. Xcode refuses to sign an app that asks for
it before the grant. That is why the default build leaves CarPlay out (`ios/Helix/Config/Helix.entitlements`).

1. Request it at [developer.apple.com/contact/carplay](https://developer.apple.com/contact/carplay/), choosing the
   voice-based conversation category and your bundle ID. Approval can take days to weeks.
2. Once granted, enable it for your App ID under Certificates, Identifiers & Profiles > Identifiers > your App ID >
   Additional Capabilities. Then regenerate or refresh your provisioning profile (automatic signing does this).
3. In `ios/Config/Helix.local.xcconfig` set
   `HELIX_APP_ENTITLEMENTS = Helix/Config/Helix-CarPlay.entitlements` and rebuild.

Without the entitlement the app works normally on the phone; it just doesn't appear in CarPlay.

## How it works

- One `CPVoiceControlTemplate`, built once, with six states: idle, connecting, listening, speaking, muted, problem.
  `render()` only calls `activateVoiceControlState(withIdentifier:)` when the app's call state changes (observation of
  `HelixStore.activeCall.phase`, `isMuted`, `callError`).
- Idle shows two action buttons, Claude (phone + C) and Astra (phone + A); in a call they become Mute and End.
  Both assistants are drawn identically. A tap calls `HelixStore.startCall`, which refuses while a call exists, so repeated
  taps never create a second session.
- The call is the same CallKit call as on the phone (`docs/CALLS.md`), so audio goes through whatever route iOS picked
  (the car when connected), and phone calls / Siri interruptions use CallKit's normal handling. This intentionally keeps
  CallKit: it is how incoming Helix calls, approval calls and the lock-screen controls already work.
- Unplugging the car does not end the call; it continues on the phone or AirPods.

## OS requirements and what the framework allows

- Action buttons need iOS 26.4+. A custom state background (`backgroundImage`) needs iOS 27. The code uses a flat
  `#121212` background on iOS 27+ and the system look before that, so on iOS 26 CarPlay shows Apple's wallpaper behind
  the template. What you see therefore depends on the phone's iOS version.
- The template shows: one title line (`titleVariants`), a state image (max 150 x 150 pt) and up to the system's maximum
  number of buttons. Button titles are ignored on this template, and a button's image area is about 30 x 30 pt, scaled into
  the pill. So the reference design's "HELIX" wordmark, subtitle, two-colour title, glow cards and "TAP TO START" labels
  cannot be drawn. Buttons carry icon + one letter instead, and the title says "Call Claude or Astra".
- The sidebar, clock and app dock are drawn by CarPlay. The Helix app icon is the app's normal icon.

## Testing

Use `Additional Tools for Xcode > Hardware > CarPlay Simulator` with the iPhone connected by USB (the simulator does not
appear in Xcode 27's Device Hub). Install the signed build on the phone, open the CarPlay Simulator, pick the phone from
Sessions, open Helix from the dock. Verified in the simulator: scene loads, idle screen with title, indicator and two
buttons. Not verified: a call started from CarPlay, mute/end buttons, the other states, a real car.

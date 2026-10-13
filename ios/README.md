# Helix for iPhone

SwiftUI app for iOS 26+, with CallKit/PushKit calls, a Siri intent extension (`HelixIntents`) and an optional CarPlay
scene. You build it yourself with your own Apple team and bundle ID. Nothing in the project is tied to a particular developer.

## Requirements

- A Mac with a current Xcode that supports iOS 26 (the project was created with Xcode 27, Swift 6).
- An iPhone on iOS 26 or later. The simulator works for the UI, but calls, push and Siri need a device.
- An Apple Developer account. A free personal team can install the app for 7 days, but it has no push, no VoIP calls and
  no Siri. For those, use a paid account and [docs/PUSH-SETUP.md](../docs/PUSH-SETUP.md).

## Configure

All per-developer settings live in one gitignored file:

```sh
cp ios/Config/Helix.local.xcconfig.example ios/Config/Helix.local.xcconfig
```

| Setting | |
|---|---|
| `DEVELOPMENT_TEAM` | Your Team ID (developer.apple.com > Account > Membership details) |
| `HELIX_BUNDLE_ID` | Your bundle ID, for example `com.yourname.helix`. The Siri extension becomes `<id>.Intents` and the tests `<id>.tests` |
| `HELIX_GATEWAY_HOST` | Optional: your gateway's Tailscale name (`my-pc.my-tailnet.ts.net`, no `https://`), pre-filled when pairing |
| `HELIX_APP_ENTITLEMENTS` | Leave as is. Switch to `Helix/Config/Helix-CarPlay.entitlements` only after Apple grants you CarPlay ([docs/CARPLAY.md](../docs/CARPLAY.md)) |

The defaults are in `ios/Config/Helix.xcconfig`, which the project uses as its base configuration. Don't put your
values there.

**Free personal team:** push, VoIP and Siri are not available to free teams, so signing fails while the entitlements ask
for them. Set `HELIX_APP_ENTITLEMENTS = Helix/Config/Helix-Free.entitlements` in your local xcconfig. Chat, approvals
and in-app calls should still work; notifications, incoming calls and Siri won't. This path is less tested than a
paid team, so please open an issue if Xcode still complains.

## Build and run

1. Open `ios/Helix.xcodeproj`.
2. Choose the `Helix` scheme and your iPhone, then Run. The first time, enable Developer Mode on the phone and trust your
   developer certificate (Settings > General > VPN & Device Management).
3. Turn on Tailscale on the phone, open Helix, go to **Settings > Pair with Your PC**, enter your gateway address and the
   code from `npm run pair` ([docs/SETUP.md](../docs/SETUP.md)).

Tests: the `Helix` scheme's test action (`HelixTests`, Swift Testing), or
`xcodebuild test -project ios/Helix.xcodeproj -scheme Helix -destination 'platform=iOS Simulator,name=<any iOS 26 simulator>'`.

## Layout

| Path | |
|---|---|
| `Helix/App` | App entry and `HelixStore`, the app state |
| `Helix/Features` | Screens: Home, Chats, Agents, Approvals, Calls, Settings |
| `Helix/Services/Gateway` | REST + WebSocket client, pairing, Keychain, wire models |
| `Helix/Services/Call`, `Speech`, `Push`, `Siri` | CallKit/PushKit, the voice loop (speech recognition, barge-in), push registration |
| `Helix/CarPlay` | The CarPlay voice template |
| `Helix/DesignSystem` | Colour tokens (generated from `design/tokens.json` by `scripts/generate-tokens.mjs`) and shared views |
| `HelixIntents` | Siri "call Claude / call Astra" extension |
| `Config` | Build settings (`Helix.xcconfig` + your local override) |

The gateway contract the app implements is [docs/CALLS.md](../docs/CALLS.md) plus the API in
[pc-gateway/README.md](../pc-gateway/README.md).

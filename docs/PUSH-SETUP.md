# Push notifications and calls: bring your own APNs key

Apple only delivers a push to an app when it is signed with the key of the **same Apple Developer team** that signed
the app. So there is no shared Helix key: you build the app under your own team, create your own APNs key, and give
it to your own gateway. This takes about 15 minutes once you have a paid account.

Without it, Helix still works: approvals, events and replies arrive in the app over the live connection. You just get
no notifications or calls while the app is closed.

## What you need

- A paid [Apple Developer Program](https://developer.apple.com/programs/) membership (push, VoIP and Siri are not
  available to free personal teams).
- The iPhone app building under your team with your bundle ID ([ios/README.md](../ios/README.md)).
- About 15 minutes.

## 1. Pick your bundle ID and team

In `ios/Config/Helix.local.xcconfig` (copied from `Helix.local.xcconfig.example`):

```
DEVELOPMENT_TEAM = ABCDE12345          // developer.apple.com > Account > Membership details > Team ID
HELIX_BUNDLE_ID = com.yourname.helix   // anything you own; must be unique on Apple's side
```

The app's push topic is `com.yourname.helix`, and the VoIP call topic is `com.yourname.helix.voip`. The Siri extension
is `com.yourname.helix.Intents`.

## 2. Register the App ID (Xcode can do this for you)

With automatic signing (the default), the first build to a real device registers `com.yourname.helix` and
`com.yourname.helix.Intents` under your team, with the capabilities from `ios/Helix/Config/Helix.entitlements`
(Push Notifications, Siri, Time Sensitive Notifications). Check it at
[Certificates, Identifiers & Profiles > Identifiers](https://developer.apple.com/account/resources/identifiers/list):
your App ID should list **Push Notifications** as enabled.

If you manage signing by hand, create the explicit App ID there and enable the same capabilities.

## 3. Create the APNs key (.p8)

1. Go to [Certificates, Identifiers & Profiles > Keys](https://developer.apple.com/account/resources/authkeys/list) and click **+**.
2. Give it a name (for example "Helix push") and tick **Apple Push Notifications service (APNs)**. If the portal asks
   you to configure it, choose environment **Sandbox & Production** and **Team Scoped (All Topics)**.
3. Click **Continue**, then **Register**, then **Download**. You get `AuthKey_<KEYID>.p8`. **Apple lets you download it only
   once.** Keep a backup somewhere safe.
4. Note the **Key ID** (10 characters, also in the file name) and your **Team ID** (Membership details).

One key works for normal alerts and VoIP calls, in both sandbox and production. You don't need certificates.

## 4. Give it to the gateway

Put the key **outside any git repository**, for example `C:\keys\AuthKey_ABCDE12345.p8`. The preflight check warns about
a key that lives inside a repo. Optionally restrict it to your account:

```powershell
icacls C:\keys\AuthKey_ABCDE12345.p8 /inheritance:r /grant:r "$($env:USERNAME):R"
```

In `pc-gateway/.env`, set all four (if any one is missing, push stays off):

```
HELIX_APNS_KEY_PATH=C:\keys\AuthKey_ABCDE12345.p8
HELIX_APNS_KEY_ID=ABCDE12345
HELIX_APNS_TEAM_ID=FGHIJ67890
HELIX_APNS_BUNDLE_ID=com.yourname.helix
```

`HELIX_APNS_BUNDLE_ID` must match `HELIX_BUNDLE_ID` from the xcconfig exactly.

## 5. Check it without a phone

```powershell
npm run push -- check
```

This validates the four settings, checks that the `.p8` is a usable EC P-256 key outside any repo, checks that Apple's
push servers are reachable from your PC, and then asks Apple's real servers (sandbox and production, alerts and VoIP)
whether they accept your key, team and topic. It sends a fake device token, so nothing reaches any phone. Apple answers
`BadDeviceToken` exactly when everything else is right. Each failure comes with advice.

Then restart the gateway: `powershell -ExecutionPolicy Bypass -File service\update.ps1`.

## 6. Test with the phone

Install the app from Xcode onto your iPhone, open it, allow notifications, and pair. On every launch the app registers
two tokens with the gateway: an alert token and a PushKit VoIP token.

| Check | How |
|---|---|
| Push is configured and tokens are registered | `GET /v1/push/status` |
| A real notification | `POST /v1/push/test {"kind":"alert"}` |
| A real incoming call | `POST /v1/push/test {"kind":"voip"}` |
| A full call scenario | `POST /v1/calls/simulate {"severity":"critical"}` or `{"severity":"important","approval":true}` (a test approval that runs nothing) |

These endpoints need a device token, and they reach every phone that registered for push. The easiest way is to pair a
terminal client (`npm run pair`, then `npm run client -- pair <CODE>`, which saves its token in `data\client.json`):

```powershell
$t = (Get-Content data\client.json | ConvertFrom-Json).token
Invoke-RestMethod http://127.0.0.1:7777/v1/push/status -Headers @{ Authorization = "Bearer $t" }
Invoke-RestMethod http://127.0.0.1:7777/v1/push/test -Method Post -Headers @{ Authorization = "Bearer $t" } -ContentType application/json -Body '{"kind":"alert"}'
```
## How Helix decides to buzz or ring

| Severity | What happens |
|---|---|
| `info` | In-app only |
| `important` | In-app + push |
| `critical` | In-app + push + an incoming call |
| Approval | Push at once; a call if still unanswered after `HELIX_APPROVAL_CALL_AFTER_MIN` (default 5, 0 = never) |

- **Presence:** pushes are sent whether or not you are at the PC, in every mode (`auto`, `home`, `away`), including
  approval requests. Presence only gates *calls*: while you are at the PC (keyboard or mouse used within
  `HELIX_PRESENCE_AWAY_MIN`, default 5 minutes), nothing rings. Everything also lands in the app. The app can force
  `away` or `home`.
- **Limits:** one ring per problem per 15 minutes, at most 3 calls per hour, and calls ring for `HELIX_RING_TIMEOUT_SEC`
  (default 30) before turning into a missed-call push.
- Push previews are short on purpose. The details stay on the PC and load when you tap.

## Sandbox vs production

Builds run from Xcode use the APNs **sandbox**. TestFlight and App Store builds use **production**. The app reports which
one with each token, and the gateway sends to the matching host. You need nothing extra, and the same key works for both.
A token sent to the wrong environment is rejected by Apple, and the gateway then marks it dead. Relaunching the app registers it again.

## Troubleshooting

| Apple says | Meaning |
|---|---|
| `InvalidProviderToken` | Key ID, Team ID or the `.p8` don't belong together |
| `TopicDisallowed` / `DeviceTokenNotForTopic` | `HELIX_APNS_BUNDLE_ID` does not match the app, or push is not enabled on the App ID |
| `BadDeviceToken` from a real token | Sandbox/production mismatch: an Xcode build token sent to production, or the reverse |
| `Unregistered` (410) | The app was deleted or the token rotated; the app registers a new one at next launch |

If calls arrive as nothing at all, check that the app has been opened at least once since installing, because PushKit
needs the app to register. iOS also stops delivering VoIP pushes to an app that fails to report a call, which the app
always does.

The full payload and endpoint contract between gateway and app is [CALLS.md](CALLS.md).

# Push notifications and calls: the contract for the iPhone app

This is the contract between the gateway and the phone app for push, calls and spoken replies. Setting up your own Apple push key: [PUSH-SETUP.md](PUSH-SETUP.md). All endpoints need the device bearer token unless noted. Full endpoint list: `pc-gateway/README.md`.

## 1. Register the phone (every launch)
Tokens change; send them each time the app starts and whenever iOS hands you a new one.

```
PUT /v1/devices/me/push-token
{ "kind": "alert", "token": "<hex>", "environment": "sandbox", "bundleId": "com.you.helix" }

PUT /v1/devices/me/push-token
{ "kind": "voip",  "token": "<hex>", "environment": "sandbox", "bundleId": "com.you.helix" }
```
- `alert` = the normal token from `registerForRemoteNotifications`. `voip` = the PushKit token (`PKPushRegistry`). They are different strings.
- `environment`: **`sandbox` for builds run from Xcode, `production` for TestFlight/App Store.** A token sent to the wrong host is rejected by Apple (the gateway then marks it dead).
- Token = hex string, 32 to 200 chars. Convert the `Data` token to lowercase hex.
- `DELETE /v1/devices/me/push-token/:kind` to unregister. `GET /v1/devices` shows what is registered (never the tokens themselves). `GET /v1/push/status` says whether Apple push is configured on the PC and how many tokens it holds.
- **Testing without waiting for a real event:** `POST /v1/push/test {"kind":"alert"}` sends a real notification; `{"kind":"voip"}` rings a real test call. Both return 409 if the gateway has no Apple credentials.

## 2. Ordinary notifications (`alert`)
Payload (what your `UNUserNotificationCenter` delegate sees):
```json
{ "aps": { "alert": {"title": "...", "body": "first line only"}, "sound": "default",
           "thread-id": "<sessionId or 'helix'>", "interruption-level": "active | time-sensitive" },
  "helix": { "kind": "event | approval | missed_call", "severity": "important | critical",
             "eventId": "...", "sessionId": "...", "approvalId": "..." } }
```
- The preview is deliberately short; fetch the full text from the gateway after the user taps (`GET /v1/conversations/:id/messages`, `GET /v1/approvals?status=pending`).
- `kind: "approval"`: open the approval card (`approvalId`). Approve/reject with `POST /v1/approvals/:id/approve|reject`.
- `kind: "missed_call"`: sent when a call rang and nobody answered.
- Critical alerts use `time-sensitive` (breaks through Focus; does not need Apple's separate critical-alert entitlement).
- A repeat push for the same approval replaces the earlier one (collapse id), so the lock screen does not stack duplicates.

## 3. Incoming calls (`voip`)
Payload delivered to `pushRegistry(_:didReceiveIncomingPushWith:...)`:
```json
{ "callId": "...", "caller": "Claude", "title": "short reason", "expects": "approval | conversation",
  "helix": { "callId": "...", "expects": "...", "severity": "critical", "approvalId": "...", "sessionId": "..." } }
```
**Apple rule:** you must call `CXProvider.reportNewIncomingCall` before returning from that delegate method, every time, or iOS kills the app and eventually stops delivering VoIP pushes. Report first, ask the gateway questions after. If the call turns out to be over already (see below), report it and end it immediately.

A call is "ringing" for 30 s by default. `GET /v1/calls/:id` gives the current state (`ringing | answered | ended | missed | declined | failed`).

### Answering
User taps Answer in CallKit, then:
```
POST /v1/calls/:id/answer      ->  Call { script, expects, routeId?, ... }
```
`409` means it is no longer ringing (declined elsewhere, missed, or the approval was already resolved): end the CallKit call.

- **`expects: "approval"`**: speak `script` aloud ("Claude needs your approval to run the command ..., in atlas. Say approve to allow it, or reject to stop it."), then listen. **The phone interprets the answer, not a language model**: match clear yes/no words ("approve", "yes", "do it", "go ahead" / "reject", "no", "stop", "cancel"). If it is ambiguous, ask again. Repeat the decision back and ask for confirmation before sending (this is a destructive action). Then:
  ```
  POST /v1/calls/:id/decision  { "approve": true | false }  ->  { call, approvalStatus }
  ```
  A decision is accepted once, on an answered approval call. Then end the call. (Why not let Claude interpret the speech: anything an agent writes could try to talk its way into an approval. A keyword match on the user's own voice cannot be prompt-injected.)
- **`expects: "conversation"`**: speak `script` aloud immediately ("Training crashed. CUDA out of memory at step 84231. What would you like to do?"), then talk through the route: the answer includes `routeId`. Send each utterance with the WebSocket command `{"type":"route.send","routeId":"...","text":"..."}` (or `POST /v1/routes/:id/message`) and speak the streamed reply (`agent.output.delta` / `agent.output.final`, see the WebSocket section of the README). The General Claude already knows why Helix called and what the phone said; it receives that with the user's first reply, so it will not repeat the script. The conversation can be handed to the session involved without ending the call (`route.handoff` event).

### Declining and hanging up
`POST /v1/calls/:id/decline` (while ringing), `POST /v1/calls/:id/end` (hang up). Both are idempotent-ish: ending an already finished call just returns it.

### Calls that end by themselves
The gateway sends WebSocket events `call.ringing`, `call.answered`, `call.ended` (with the full `call`). `call.ended` while your CallKit call is still ringing means it no longer matters (for example the approval was approved from the app): dismiss it with `CXProvider.reportCall(with:endedAt:reason:)`. If the app is not connected, the VoIP push already woke it and the call is handled as above.

### Hanging up on a goodbye (`call.hangup`)
When the user says a clear goodbye on a call ("okay bye", "that's all"), or the agent they are talking to (the front door or a handed
session) calls its `end_call` tool, the gateway sends `call.hangup { call, afterSpeech: true }`. Speak the goodbye reply that follows
to the end, then hang up (`POST /v1/calls/:id/end`). The gateway ends the call itself shortly after the reply if you do not
(`endReason: "hung up after goodbye"`), so also treat `call.ended` on an answered call as "tear down audio and CallKit". Goodbyes in
text chats do nothing.

### Missed calls
After the ring timeout the call becomes `missed` and the user gets a normal push with `helix.kind = "missed_call"`.

## 3b. Speaking: voice replies and the personality
Send what the user said with `voice: true` so the reply comes back worded for speech and in the user's chosen personality:
```
WS  {"type":"route.send","routeId":"...","text":"...","voice":true}          // or POST /v1/routes/:id/message, /v1/sessions/:id/message
```
- On an answered call the route already knows how serious the call is, so replies on an urgent call stay plain whatever the personality setting. Pass `"voiceSeverity": "info|normal|warning|high|critical|approval"` to override for one message.
- Reading the app (typing) should not set `voice`. Strip leftover markdown and emoji before text-to-speech anyway; the instruction asks for none but the model is not a filter.
- Settings screen: `GET/PUT /v1/persona` (mode, teasing, flirtiness, sarcasm, verbosity, and your own `speech {rate,pitch,voiceId}` to sync across devices), `POST /v1/persona/preview` to try a setting, and `effective` in the GET shows how the character fades by severity (the "suppression preview").

## 4. The user calls Helix
```
POST /v1/calls/start                        { }                          -> Call (already answered) with routeId and ringbackMs (1000-3000, random each call: play a ringback tone this long, then speak `script`)  // "Call Claude"
POST /v1/calls/start                        { "sessionId": "<helix id>" } -> Call with routeId, conversation already handed to that session
POST /v1/calls/start                        { "provider": "codex" }      -> "Call Astra": Call with a Astra (Codex) routeId; same route API as Call Claude
```
The response's `script` is the **greeting to speak once connected** (in the user's personality). Report it to CallKit as an outgoing call, speak the greeting, then speak/listen through the route exactly as for a conversation call (with `voice: true`).

## 5. When the gateway rings you
- Pushes are sent wherever the user is, at the PC or away (approval requests included, on the first request). Only **calls** (ringing) are limited to when the user is **away from the PC**. At the PC everything also lands in the app via WebSocket. `GET/PUT /v1/presence` (`auto | away | home`) is how the app shows and overrides that.
- An approval that nobody answers by push escalates to a call after 5 minutes (`HELIX_APPROVAL_CALL_AFTER_MIN` on the PC).
- Hard limits: one ring per problem per 15 minutes, 3 calls per hour overall.

## 6. What the PC needs from you
The `.p8` key file, Key ID, Team ID and bundle ID, to put in `pc-gateway/.env` ([PUSH-SETUP.md](PUSH-SETUP.md)). Never commit them. Without them the gateway reports push and call as "unavailable" and everything else still works.

## Speaking replies: speech-ready sentences, recognizer hints, spoken status (gateway side, DONE)

For anything the phone speaks aloud, send the message with `"voice": true` (as before). On top of the persona style, the
gateway now also hands the phone **clean text to speak**, so the app does not have to strip markdown itself and can start
talking before the model has finished.

- **`agent.speech`** (WebSocket event, voice turns only): `{ type, sessionId, turnId, seq, text }`. One complete sentence per event, in order, `seq` from 0 within the turn. Markdown, links ("a link"), long paths (just the file name), emoji and code blocks ("There is some code in the chat.") are already removed. Speak them one after another with `AVSpeechSynthesizer`; the first arrives as soon as the first sentence is complete, typically well before the reply ends. A tool call in the middle of a reply ends the sentence in progress, so narration like "Let me check the logs." is spoken before the tool runs.
- **`agent.output.final`** gains `spoken` (voice turns only): the whole reply cleaned for speech, identical to the sentences joined with spaces. Use it to re-speak or to show a "speaking" transcript; the normal `text` still carries the markdown for the chat view.
- **Barge-in:** interrupt as before (`route.interrupt` / `POST /v1/routes/:id/interrupt`); no further `agent.speech` events are sent for that turn, so stop the synthesizer and drop anything queued.
- **Typed messages** (no `voice`) produce neither `agent.speech` nor `spoken`.
- **`GET /v1/voice/hints`** -> `{ strings: [...] }`: up to 100 short names (aliases, project names and how a person says them, session and watch titles, plus Helix, Claude, Codex, approve, reject, interrupt). Pass them to `SFSpeechAudioBufferRecognitionRequest.contextualStrings` so "cat diffusion" is not heard as something else. Fetch it when a call starts (it changes as sessions come and go).
- **`GET /v1/digest`** -> `{ spoken, counts }`: an instant, model-free spoken status ("2 approvals are waiting for you. The oldest is: ... 1 watch is firing: training log. Working right now: cat diffusion."), or "All quiet. Nothing is running or waiting." Good as the first thing said after the greeting, or for a "status?" question without waiting for the model. `counts` = `{ approvalsPending, sessionsWorking, sessionsOpen, watchesFiring, watchesFailing }`. The digest is said **in the user's persona**, dialled down by `kind`: `quiet` and `busy` get the full personality (a different way of saying "nothing is going on", or an opener like "Okay, status report time."), `attention` (a watch firing or failing) only a light touch ("Small wrinkle."), and `urgent` (an approval is waiting) none at all. The facts are identical in every mode. `kind` is in the response; `?plain=true` returns the neutral wording whatever the persona.

## The PC voice (optional) and pre-recorded clips

Add `"engine": "pc"` next to `"voice": true` on a message (`/v1/sessions/:id/message`, `/v1/routes/:id/message`, or the websocket `send` / `route.send`) to have the PC speak the reply in the chosen voice. Events, in order: `agent.speech` (each sentence, with `engine`, `style`), `agent.audio` (`{seq, sampleRate, format: "pcm_s16le", data}`, raw mono 16-bit PCM, base64, one per sentence, play in `seq` order), `agent.speech.end {cancelled}`, `agent.audio.end`. If the PC voice cannot speak you get one `agent.audio.unavailable {reason, message}` for the turn: speak the `agent.speech` text with Apple's voice instead. Reasons: `disabled`, `not_configured`, `gpu_busy`, `gpu_unknown`, `ram_low`, `start_failed`, `speech_failed`.
`POST /v1/voice/tts/warm` (start it when a call begins), `GET /v1/voice/tts/status`, `POST /v1/voice/tts/stop`, `POST /v1/voice/speak {text, style}` (one sentence of raw PCM, `x-sample-rate`). It is off by default, starts only when needed, refuses to start while the GPU or RAM is busy, and stops itself when idle ([LOCAL-TTS.md](LOCAL-TTS.md)).
`GET /v1/voice/clips` and `GET /v1/voice/clips/:id` serve the pre-recorded canned lines (wav); `GET /v1/voice/filler` includes the matching `clip`.
`petNames` in `GET/PUT /v1/persona` is the list the flirty mode picks pet names from. The Codex front door is named **Astra** (`Call Astra`).

## Flirty persona and the instant filler

- Persona mode `flirty` (with `flirtiness` as the dial) makes the agent's **answers** flirty in conversation, not only the greeting. Safety fades it exactly as before, with one change: an event that needs attention (`warning`, i.e. `important` alerts) now keeps a small share of the flirting (x0.4) instead of none. `high`, `critical` and `approval` still have no flirting, and critical alerts and approvals have no persona at all.
- `GET /v1/voice/filler?severity=normal|warning|high|critical|approval|info` -> `{ text, severity }`: what to say the instant the user stops talking, while the agent works ("Mmm... let me check." in the flirty mode; "One moment." for anything serious).

## Rehearsing calls without waiting for a real event

`POST /v1/calls/simulate` rings the phone through the real VoIP path with a chosen scenario:

```text
POST /v1/calls/simulate { "severity": "critical" | "important", "title"?, "summary"?, "approval"?: true }
  -> 201 { call, approvalId? }
```

- Without `approval`: an ordinary event call (answer it, a conversation route opens with the call's context, speak in the serious voice for `critical`).
- With `approval: true`: also creates a real pending approval, labelled "Test only, nothing will run", and the call asks about it. Answer with `POST /v1/calls/:id/answer` then `POST /v1/calls/:id/decision { approve }` exactly like a real approval call.
- Needs Apple push configured (`409` with a pointer to `npm run push -- check` otherwise) and a registered VoIP token (`502` "no phone has registered" otherwise; nothing is left pending). Rate limited to 6 per minute. `POST /v1/push/test` still sends a plain test alert or a basic test call.

## Checking the Apple setup from the PC

`npm run push -- check` (in `pc-gateway`) needs no phone: it checks the four `HELIX_APNS_*` settings, that the `.p8` is a usable EC P-256 key outside any git repository, that Apple's push servers are reachable from this PC, and then asks Apple's real servers (sandbox and production, alerts and calls) whether they accept the key, team and bundle id. It does this with a fake device token: Apple answers `BadDeviceToken` exactly when everything else is right. Each failure comes with plain advice (wrong Key ID or Team ID, bundle id not enabled for push, firewall).

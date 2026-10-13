# Live Desktop Viewer

## WebRTC failure fallback (v3)

The deployed incident logged `WEBRTC_FAILED` (diagnostic `8c889912-f7fe-4559-9e29-1cd47623e55f`), followed by a
reconnection and later an explicit model `stop_desktop_control`. It did not log an encoder exit. The earlier log
does not distinguish ICE/consent loss from other transport failures, so a specific firewall/NAT cause is unproven.
Transport-state diagnostics now include ICE state, selected candidate types/protocol and consent/packet counters,
never addresses, SDP or credentials.

After WebRTC negotiation/media failure, v3 automatically switches to an independent 8 fps JPEG stream over the
existing authenticated WSS gateway tunnel. FFmpeg captures the selected monitor(s) into a loopback-only TCP
receiver; `/mcp/live-desktop/frames` forwards bounded JPEG frames to a canvas. It uses the same session capability,
single-viewer limit, stop/revocation gates and encoder job supervision. It neither calls model screenshot tools nor
refreshes control leases. Slow consumers drop frames rather than accumulating a queue. This is a compatibility
fallback, not a 30–40 ms latency guarantee or a fix for an unavailable WSS tunnel. No TURN account is required.

On normal completion the card still closes automatically. If a viewer error occurred and remains relevant, control
stop clears video/canvas immediately but leaves an **error-only notice with Dismiss**. It does not retain desktop
pixels or continue capture. Host teardown remains authoritative.

Verification: 42 focused tests pass; TypeScript and native helper compile. Chrome sustained local WebRTC beyond
one minute. A forced WebRTC failure switched to moving JPEG test-pattern frames through the production fallback
route; stop cleared the image while retaining the error notice. Deployed ChatGPT/iOS and actual native fallback
capture remain post-deploy checks. Refresh tools after deployment for `ui://helix/live-desktop/v4.html`.
Local QA supports `--synthetic --fallback-test`; its capture limit is now 110 seconds.

## Disconnect recovery (v2)

The card preserves the original failure instead of replacing it during socket cleanup. It reconnects to the same
session capability (1, 2, 4, 8, 10 seconds, then every 30 seconds); this cannot start or extend desktop control.
Explicit end/expired-capability responses dismiss it. Six-second heartbeat delays no longer destroy video;
signaling has a 30-second grace and visible playback has a separate 20-second progress watchdog.
Callbacks from retired connections are ignored. During network outages, learning that control ended necessarily
waits for connectivity/reconnection; native capture still stops independently.

Gateway failures are structured log records with `component: "live-desktop"`, `code`, `diagnosticId`, `message`, and
redacted `detail`. The card shows the same ID and original error. Native encoder status includes its exit code and
up to 4 KB of recent FFmpeg stderr, including monitor-restart failures. Browser-side errors are reported over the
existing authenticated signaling connection (or the next successful reconnection). No screen data, full signaling
messages, SDP, candidates or capability URLs are logged. WebSocket code 1006 is sometimes all the browser exposes;
it must not be represented as a known network root cause.

Inspect the existing `data/logs/helix-gateway.out.log` for `Live desktop failure` or `Live desktop diagnostic`.
Deploy with the existing service updater, then **refresh Helix tools** for `ui://helix/live-desktop/v2.html` and use
a fresh chat. This version was build/compile tested with 39 focused regression tests, including original-error
preservation, stale callbacks, timeout/reconnect, end-of-control, secret redaction and actual gateway log records.
Restart the service (`service/update.ps1`) after updating so ChatGPT gets the new viewer.

`start_desktop_control` renders one compact, stream-only widget. Screenshot/action tools do not render more cards.
The viewer follows the monitor(s) selected by the existing control helper and gold aura. The screenshot → action →
screenshot contract, frameId validation and input safety remain the model-facing path. Video is spectator-only.

## Lifecycle and privacy

- A random capability in tool-result `_meta` binds the viewer to its exact credential and active control ID.
  It is not included in model content. One connected viewer per session. Historical cards cannot restart control.
- Capture starts only after an authenticated viewer negotiates WebRTC. No visible sender tab or display picker.
- Stop, physical takeover, lock, helper disconnect, grant revocation or control expiry ends capture and the stream.
  Native stop notifications are immediate; lost/revoked connections have bounded watchdog fallbacks.
- The widget stops tracks, clears the last image, reports zero height and calls ChatGPT's `requestClose()` when present.
  The host controls actual card dismissal; plugins cannot delete historical chat messages.
- The model MUST call `stop_desktop_control` before finishing its answer. There is no gateway event for “model finished
  thinking”; the existing 120-second idle lease is the fallback, not a promise of instant closure without a stop call.
- Viewer traffic never refreshes that lease or creates model screenshots. No audio, recordings, input channel or logs
  of screen content. Closing the widget stops its encoder without interrupting the model's control session.

## Transport

Interactive Windows helper → FFmpeg GDI desktop capture → loopback RTP → gateway `werift` → encrypted WebRTC → widget.
Signaling alone goes through `/mcp/live-desktop/signal` over HTTPS/WSS/Funnel. Video does **not** flow through MCP or
through Funnel. Capture is H.264 baseline, 1280×720 letterboxed, 30 fps, roughly 2 Mbps, two CPU encoder threads.
Monitor switches restart capture with RTP continuity preserved. The encoder runs in a kill-on-close Windows job.

Requires Node 22+ (deployment uses Node 24) and FFmpeg with `gdigrab`/`libx264`, already installed on this PC. Lookup:
user's WinGet link, then PATH. No GPU encoder or ML workload is used. No changes to the approval system.

Direct ICE/STUN is the default. Some mobile/corporate networks require a TURN relay; configure
`HELIX_VIEWER_ICE_SERVERS` as a JSON array of `{urls, username?, credential?}` in the private `.env`.
TURN credentials are supplied to the authorized widget and should be short-lived. No relay service is provisioned by
this implementation. The existing public-DNS fix remains required if Chrome resolves Funnel to a private tailnet IP.
The 30–40 ms glass-to-glass target is not measured or guaranteed. RTT alone is not video latency.

## Deploy and verification

1. Run `powershell -ExecutionPolicy Bypass -File service\update.ps1` to build/restart with admin rights.
2. Refresh Helix tools in ChatGPT's connection settings (metadata changed on `start_desktop_control`). Start a fresh chat.
3. A desktop task should show the actual selected monitor automatically, with no Viewer Lab/test/sender steps.
4. Stop control or physically take over: the stream must disappear, with no retained last desktop frame.

Automated: `npm run build`, then `node --test --test-isolation=none dist/test/live-viewer.test.js
dist/test/computer.test.js dist/test/viewer-probe.test.js` (single line). Native compilation:
`powershell -NoProfile -ExecutionPolicy Bypass -File hooks/computer-helper.ps1 -Bootstrap unused -CompileOnly`.
Opt-in actual desktop capture smoke check, no input: `powershell -NoProfile -ExecutionPolicy Bypass -File
hooks/computer-check.ps1 -ViewerOnly`. This checks H.264 RTP on each monitor and shutdown.

Local browser harness after build: `node test/fixtures/live-viewer-preview.mjs`, open `http://127.0.0.1:7799`.
It is not installed in the service, has CSRF-protected start/stop and a 60-second capture limit.
`--synthetic` tests the production WebRTC/player path with an externally supplied FFmpeg test pattern; it is not
evidence of desktop capture. `--manual-helper` separates helper launch for development environments.

Verification on 2026-10-07: native helper and TypeScript compile; 31 focused tests pass; Chrome displayed 1280×720 H.264
test-pattern video (over 500 decoded frames, approximately 30 fps), and stop collapsed the player. The restricted
agent shell denied native pipe/process access, so actual Windows capture through the deployed helper and the new
viewer inside ChatGPT web/iOS still require post-deploy verification. Earlier synthetic iOS tests are not that proof.
The broader hosted/OAuth run passed 99/100 tests; the existing `hostname` command test cannot spawn PowerShell in
this sandbox. No service restart or deployment was performed by the agent.

## ChatGPT floating mode probe and instant handoff (v4)

- The card resource now declares `availableDisplayModes: ["inline", "pip", "fullscreen"]` (`ui://helix/live-desktop/v4.html`).
  Refresh the Helix connector after deploying so ChatGPT drops the cached v3 card.
- **Pop out** starts every request inside the tap: the browser's picture-in-picture (or Safari's `webkit` API) first, then
  `window.openai.requestDisplayMode({mode:"pip"})`. A grant of `pip` or `fullscreen` pins the stream to that card (mobile
  hosts may answer fullscreen); a refusal pins nothing and the card keeps working.
- Card events in the gateway log (`CARD_EVENT`) show what happened on the phone: `pop_out_tapped`, `pip_failed`,
  `host_pip_requested`, `host_pip_granted` / `host_pip_refused` (asked vs granted), `display_mode`, `stood_down_replaced`,
  `stood_down_popout`.
- A card that loses the stream goes quiet (no `requestClose`), so two copies no longer fight.
- A new card paints the screenshot that came with the tool result at once, then switches to live video.
- **Not promised:** a card that persists on iPhone. If ChatGPT refuses or destroys cards, only the instant handoff helps;
  the real result needs a test on the phone. Not built: overlapping old/new viewers during handoff (one encoder only).

## Helix Live thread panel (prototype, independent of tool-result cards)

A tab the **user** opens inside a conversation, not a card produced by a model tool call. Built to the OpenAI MCP
extensions "thread entrypoint" (spec: `github.com/openai/mcp-extensions/blob/main/docs/spec.md`, Plugin Extensions guide).

- **Tool** `helix_live_panel` (no arguments; the host calls it with `{}`), `_meta`:
  `ui: { resourceUri: "ui://helix/live-panel/v1.html", visibility: ["model", "app"] }`, `"openai/ui": { entrypoints: [{ type: "thread" }] }`,
  `readOnlyHint`. Registered only for credentials with the desktop grant, next to the computer tools.
- **What it does:** looks up the control session this credential already holds and returns, in `_meta` only (never in model
  content), `{ origin, ticket, seat, panelKey, iceServers }`, or `{ active: false }`. It never starts control, never
  renews the 120 s lease (verified by test), starts no capture, and writes an audit line only when it hands out a ticket.
- **Panel page** states: `idle` (no session; looks again every 4 s, read-only) -> `connecting` -> `live` -> `ended`
  (pixels cleared at once, panel stays open and waits for the next session). Same WebRTC/JPEG gateway routes as the
  cards; no second capture pipeline. WebRTC failure falls back to the authenticated JPEG stream.
- **Ownership:** the panel connects with `panel=<panelKey>`. The key is random, issued only by `helix_live_panel`, valid
  only for that control session, and checked on the server; a card's ticket/seat or a made-up flag is refused (4403).
  A panel keeps the stream against any later tool-card seat (cards get 4411 with a "Helix Live panel" note). A newer panel
  takes it from an older one; the older one shows "Watch here". Issuing a key never moves the stream; only connecting does.
  A dropped panel keeps its claim for 15 s and returns with the same key and seat (no re-issue).
- **Revocation:** control stop / physical takeover ends the session; its tickets and keys die with it.
- **Tests:** `test/live-viewer.test.ts` (metadata, scope, no-session, lease, forged key, replay, owner vs card, reconnect,
  stop revocation, page state machine, fallback).

### Not verified (needs ChatGPT / the iPhone)
- The docs say thread entrypoints are supported on Desktop, Web, iOS and Android, but not whether the tab stays visible
  while the model calls tools, or whether iOS shows it as a tab, side-by-side, or fullscreen. Do not assume floating video.
- **Found on the first refresh:** with `visibility: ["app"]` ChatGPT said "These private tools can't render their widgets: helix_live_panel". The tool is now `["model", "app"]` (read-only; its description tells the model not to call it). Re-test after redeploying.
- Whether the host calls `tools/call` from the panel (`host.callTool` or the postMessage bridge); the page tries both.
- Refresh the Helix connector after deploying so ChatGPT picks up the new tool and resource.

### Panel showed "Desktop control ended" after every tool call (fixed)
Symptom: the Helix Live panel was mounted and the gateway log showed no stop (the panel owned the stream, tool cards were turned away,
the only `VIEWER_ENDED_WITH_CONTROL` was the real stop), yet the panel read "Desktop control ended. Waiting for the next session."
Cause (client side): on every tool call ChatGPT re-sends what it holds for the widget (`openai:set_globals`, `ui/notifications/tool-result`).
For the panel that is the result of the call that opened it, `{ active: false }` from before control started. The panel treated
"no ticket" as "control ended", released the working stream and went idle; its idle lookup then did not recover it.
Fix: in panel mode only the gateway ends the stream (`ended` message, close 4404/4403). Host-pushed results are ignored while the
panel is watching, and while idle only a pushed result that carries a panel key (the opening result) is accepted. A card ticket or a
stale ticket pushed by the host can no longer restart or end it. Tests: `stale or other tools' results` (page) and
`three or more computer-use calls while the Helix Live panel is mounted` (gateway: start, panel connects, 5 more calls, each tool
card refused, no `ended`/`error` reached the panel, control untouched, real stop ends it).
Not verified on a phone: the exact events ChatGPT sends, so the next test should check the panel survives several calls.

### Per-call cards are off by default (panel only)
The live-desktop card under each computer-use call is now disabled: `HELIX_VIEWER_CARDS` (default off; `true` brings the cards back).
With cards off, no tool result carries viewer data, the `v4` card resource is not registered, and the only widget is the Helix Live
panel (`helix_live_panel`), which looks the session up itself. Without the panel open there is no viewer, by design.
After deploying, refresh the Helix connector so ChatGPT drops the cards from the tool list.
Mobile note from the first iPhone test: the panel appeared as a fullscreen UI with a "Watch here" button (no side panel); "Watch here"
means another panel instance (for example the desktop one) holds the stream, and tapping it takes it back.

### Panel fixes after the first iPhone test
- **Watch here shrank the panel to a thin line:** standing down hid the video and "Watch here" never brought it back, so nothing was left
  to give the panel height. It now restores the video box, and panel mode has `min-height: 200px`.
- **Copies fighting:** each time the model calls `helix_live_panel`, ChatGPT renders another panel widget that claims the stream (newest wins),
  so older copies show "Watch here". A displaced copy now takes the stream back by itself when it becomes the visible one
  (`visibilitychange` / intersection), and does not fight while it is not.
- **Panel stays open after the session ends:** on a real end (gateway `ended` / 4404) the panel now asks the host to close it
  (`requestClose`, best effort; unknown whether a thread panel honours it, it keeps waiting if not). Refused keys, stand-downs and
  "no session yet" never close it.
- **Not possible:** opening the thread panel automatically when control starts. The host only opens thread entrypoints on the user's action;
  the model calling `helix_live_panel` is the only automatic route and it renders an inline widget.

### Two panel copies per session: the older one never closed
Gateway log (every session): seat 1 connects, two seconds later seat 2 connects and replaces it. Each `helix_live_panel` call renders another
panel widget, and the newest claims the stream. The older copy stands down ("Watch here") and, having no socket, never receives the gateway's
`ended`, so it stayed open after the session while the newer copy closed cleanly.
Fix: a copy that stood down now peeks every 4 s (`helix_live_panel` with `{ peek: true }`: returns only `{ active, peek: true }`; no ticket, no key,
no seat, not audited). When the session is gone it clears and asks the host to close itself, like the other copy. A running session never makes a
peeking copy fight for the stream. A peek in flight never blocks the user's own "Watch here" lookup.

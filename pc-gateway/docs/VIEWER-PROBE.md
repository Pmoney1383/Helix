# Helix viewer compatibility probe

This is a small synthetic test, not the desktop streamer. It does not start computer control, capture a screen,
request camera/microphone access, or read/use model frame IDs. Existing desktop tools are unchanged.

## Run in ChatGPT web and mobile

1. Deploy from `pc-gateway` with `powershell -ExecutionPolicy Bypass -File service\update.ps1`.
2. Refresh the Helix connection's tools/UI metadata in ChatGPT and start a new chat with Helix selected.
3. Ask: **Use Helix's test_desktop_viewer tool to open its viewer compatibility test.**
4. Press **Run 20-second test**. Look for an animated gold block in the video, increasing gateway tick counts,
   and presented/decoded video frames. Try **Expand**. Keep the test visible for the full run.
5. Open **Diagnostic results**, copy the JSON, and label it with the client tested (web or iPhone).
6. Repeat in the other client. Open a fresh test if its five-minute ticket has expired.

The tool is available only to credentials with the existing desktop grant. `HELIX_PUBLIC_URL` must be configured for
the network test. Routes live under the already-forwarded `/mcp/viewer-probe/` prefix; no Funnel changes are required.
Probe tickets travel only in UI metadata, have no authority to control the desktop, expire after five minutes, and
stop working when the desktop grant is revoked. Network sockets stop after 30 seconds; the UI stops after 20 seconds,
on Stop, when hidden, or on teardown. Up to four network probes can run concurrently. No results are stored on the PC.

## What the results mean

- Host UI: verifies that this ChatGPT client mounted the component and initialized its bridge.
- HTTPS: tests a direct request from the widget to the gateway through the configured public URL.
- Live connection: receives synthetic ticks over WebSocket and measures ping/pong round-trip time to the gateway.
- Local video: sends a canvas animation between two WebRTC peers in the **same widget**, then counts video frame
  callbacks (or decoded frames on older clients). This tests API availability, codec negotiation and playback.
- Expand: asks the host for fullscreen. The host chooses the placement; this is not a floating desktop window.

Passing all of these does **not** establish remote WebRTC connectivity, STUN/TURN compatibility, Windows capture/encoder
performance, sustained playback while the model is running tools, or 30–40 ms capture-to-display latency. Failure of
canvas capture also does not by itself prove receive-only remote video is impossible. The next stage is a synthetic
PC sender and remote receiver test, then actual desktop capture only after that passes. Network RTT is not video delay.

OpenAI's [UI guide](https://developers.openai.com/plugins/build/chatgpt-ui) describes picture-in-picture, while the
[extension spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#display-modes) currently lists only
inline/fullscreen support. This probe uses inline/fullscreen; floating mode is not assumed.

## Local verification

`npm run build`, then `node --test --test-isolation=none --test-timeout=30000 dist/test/viewer-probe.test.js dist/test/computer.test.js`.
These checks cover MCP metadata, authentication, ticket expiry/revocation, actual WebSocket messages, and the existing
desktop controller. They cannot establish compatibility inside the real ChatGPT web/iPhone hosts.

For a synthetic local browser preview, run `node test/fixtures/viewer-probe-preview.mjs` after building, then open
`http://127.0.0.1:7798`. This supplies a simulated host bridge, not ChatGPT. Stop it with Ctrl+C after testing.

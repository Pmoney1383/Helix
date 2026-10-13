# Remote synthetic viewer test

This extends `test_desktop_viewer`; the screenshot/action/frameId path is unchanged.
It does not capture the desktop. A visible PC browser generates 640x360, 30fps
canvas video and sends it over WebRTC to the ChatGPT widget. The gateway relays
only SDP/ICE signaling. No new packages, native encoders, or GPU jobs are needed.

## Run

1. Deploy with `powershell -ExecutionPolicy Bypass -File service\update.ps1`.
2. Open a fresh `test_desktop_viewer` card in ChatGPT (resource v2).
3. Press **Test remote PC video**. Copy the temporary sender URL into a browser
   on the PC and press **Start sender**. Put the sender in a separate visible
   browser window on the second monitor, or keep both windows side by side.
   Chrome throttles hidden tabs and the video can look frozen. For mobile, send
   the URL privately to the PC; do not open
   the sender on the phone. The URL grants access to this synthetic test only.
4. Confirm moving gold video appears in ChatGPT, then copy diagnostics while
   running. Repeat from the mobile app with a new test/link.
5. Stop from either end or close a page. Both peers disconnect. Hard limit: two
   minutes; tickets expire in five minutes and honor desktop-grant revocation.

WebRTC uses Google's public STUN service (it receives the peer's network address).
No TURN service is configured. A failure on cellular/restrictive NAT may require
TURN in the next step; passing local playback does not establish remote support.
Only one sender and one viewer per ticket; at most four rooms. Signaling is size
and rate bounded. Tickets, SDP and ICE are not intentionally logged or persisted.

`remotePresentedFrames`/`remotePlaybackFps` prove browser presentation when
supported. `remoteDecodedFrames` comes from receiver stats. `mediaPathRttMs` is a
data-channel round trip; `iceRttMs` is ICE RTT. Neither measures glass-to-glass
latency. `jitterBufferMeanMs` is the receiver's lifetime average buffering delay.
PC capture and calibrated end-to-end latency remain future work after this test.

The Windows single-host public DNS override is still needed when MagicDNS makes
Chrome classify the Funnel hostname as a local-network target.

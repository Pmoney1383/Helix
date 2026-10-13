import CallKit
import AVFoundation

/// Owns the native call UI (CallKit) and the voice loop behind it - outgoing calls, and incoming
/// ones the gateway rings through a PushKit VoIP push (see `PushService`).
/// Ported from an early prototype, which proved this
/// exact shell live on a physical iPhone, and wires the voice loop to closures instead of a
/// hardcoded echo.
final class CallAudioManager: NSObject {
    let voiceLoop = VoiceLoop()

    /// Fires once CallKit has activated the audio session and the engine confirms it is
    /// capturing - the right moment to speak the greeting (see `VoiceLoop.start`'s `onReady`).
    var onReadyToSpeak: (() -> Void)?
    /// Fires when the call ends, from either side (the user tapped End, or `endCall()` was
    /// called programmatically after the gateway said the call is over).
    var onCallEnded: (() -> Void)?

    /// The user tapped Answer on an incoming call; the argument is the gateway's call id.
    var onIncomingAnswered: ((String) -> Void)?
    /// The user declined (or the ring was ended) before answering; the gateway's call id.
    var onIncomingDeclined: ((String) -> Void)?

    /// Mute changed from anywhere: the in-app button, the lock screen / Dynamic Island, or an
    /// AirPods press. CallKit routes all of them through `CXSetMutedCallAction`.
    var onMuteChanged: ((Bool) -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private(set) var activeCallID: UUID?
    /// Gateway call id of an incoming call that has been reported but not answered yet.
    private var ringingGatewayCallID: String?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        // `queue: nil` would have CallKit invoke delegate methods on its own private serial
        // queue. This target sets SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor, so every method
        // here is implicitly @MainActor - calling them off the main queue trips Swift's runtime
        // isolation check (`BUG IN CLIENT OF LIBDISPATCH: Block was expected to execute on
        // queue [com.apple.main-thread]`), confirmed as a live crash on device. Passing `.main`
        // explicitly makes CallKit's callback queue match the isolation Swift already assumes.
        provider.setDelegate(self, queue: .main)
    }

    /// Reports the call to CallKit immediately (for the native call UI), which is independent of
    /// whether the gateway call has actually been created yet - call this as soon as the user
    /// taps "Call Claude"/"Call Astra", not after the network round trip.
    @discardableResult
    func startOutgoing(handle: String) -> UUID {
        let id = UUID()
        activeCallID = id
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: handle))
        action.isVideo = false
        controller.request(CXTransaction(action: action)) { error in
            if let error { print("CallAudioManager: start call failed: \(error)") }
        }
        return id
    }

    /// Apple rule (docs/CALLS.md section 3): every VoIP push must reach this before the push
    /// delegate returns, so `completion` runs only after CallKit has accepted the report.
    /// Everything about the call beyond the caller name is fetched from the gateway afterwards.
    func reportIncoming(gatewayCallID: String, caller: String, completion: @escaping () -> Void) {
        let id = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        activeCallID = id
        ringingGatewayCallID = gatewayCallID
        provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
            if let error {
                // Typically another call is already up (we allow one). Nothing to ring.
                print("CallAudioManager: incoming call not shown: \(error)")
                if self?.activeCallID == id {
                    self?.activeCallID = nil
                    self?.ringingGatewayCallID = nil
                }
            }
            completion()
        }
    }

    /// The gateway says a call we are still ringing for no longer matters (answered elsewhere,
    /// missed, or the approval was resolved in the app). Dismisses the CallKit ring.
    func dismissRinging(gatewayCallID: String, reason: CXCallEndedReason = .remoteEnded) {
        guard ringingGatewayCallID == gatewayCallID, let id = activeCallID else { return }
        ringingGatewayCallID = nil
        activeCallID = nil
        provider.reportCall(with: id, endedAt: .now, reason: reason)
    }

    func endCall() {
        guard let id = activeCallID else { return }
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { error in
            if let error { print("CallAudioManager: end call failed: \(error)") }
        }
    }

    /// Asks CallKit to mute so the system UI and headset stay in sync with the app.
    func setMuted(_ muted: Bool) {
        guard let id = activeCallID else { return }
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { error in
            if let error { print("CallAudioManager: mute failed: \(error)") }
        }
    }

    func speak(_ text: String) {
        voiceLoop.speak(text)
    }
}

extension CallAudioManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        voiceLoop.stop()
        activeCallID = nil
        ringingGatewayCallID = nil
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        configureAudioSession()
        let gatewayID = ringingGatewayCallID
        ringingGatewayCallID = nil
        action.fulfill()
        if let gatewayID { onIncomingAnswered?(gatewayID) }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        configureAudioSession()
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: nil)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        voiceLoop.stop()
        voiceLoop.isMuted = false
        onMuteChanged?(false)
        activeCallID = nil
        let declined = ringingGatewayCallID
        ringingGatewayCallID = nil
        action.fulfill()
        if let declined {
            onIncomingDeclined?(declined)
        } else {
            onCallEnded?()
        }
    }

    /// Mic + STT + TTS must only start here, once CallKit has activated the session - starting
    /// earlier races the hardware route switch (see `VoiceLoop.start`).
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        voiceLoop.isMuted = action.isMuted
        onMuteChanged?(action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("CallAudioManager: audio session activated; route: \(VoiceLoop.routeDescription())")
        // No route override: the system picks the connected AirPods / headset / car, and the
        // iPhone earpiece otherwise. The user can switch to Speaker with the Audio button.
        voiceLoop.start { [weak self] in
            Task { @MainActor in self?.onReadyToSpeak?() }
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        voiceLoop.stop()
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // voiceChat mode enables echo cancellation, which barge-in depends on.
            try session.setCategory(
                .playAndRecord, mode: .voiceChat,
                options: [.allowBluetoothHFP, .allowBluetoothA2DP]
            )
        } catch {
            print("CallAudioManager: audio session config failed: \(error)")
        }
    }
}

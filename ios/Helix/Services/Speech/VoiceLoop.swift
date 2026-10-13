import Foundation
import AVFoundation
import Speech
import OSLog

/// Some AVFoundation/Speech completion-handler payloads (`AVAudioPCMBuffer`) aren't Sendable,
/// but the APIs that hand them to us guarantee sole ownership at that point - wrapping lets them
/// cross from a `@Sendable` callback into the `@MainActor` hop it needs without the compiler's
/// region-isolation check misreading that single-ownership handoff as a data race.
private nonisolated struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value
}

/// Synchronizes request replacement with the audio tap. Once detached, an ended request
/// cannot receive another buffer, and the real-time callback never touches actor-owned state.
private nonisolated final class RecognitionAudioInput: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func replace(with request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        defer { lock.unlock() }
        self.request = request
    }

    private var muted = false

    func setMuted(_ muted: Bool) {
        lock.lock()
        defer { lock.unlock() }
        self.muted = muted
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !muted else { return }
        request?.append(buffer)
    }
}

/// Mic capture, Apple Speech transcription, `AVSpeechSynthesizer`, and barge-in, all sharing one
/// `AVAudioSession` - the one CallKit activates for a call. Ported from an early prototype,
/// which proved this exact approach live on a
/// physical iPhone (speaker, and the fixes below were each found and verified there too):
/// echo cancellation needs `setVoiceProcessingEnabled`, not just the session mode; a plain
/// `AVSpeechSynthesizer.speak()` gives the AEC unit no reference signal for what's playing and
/// the mic goes deaf while TTS plays unless TTS is rendered through the same engine graph.
///
/// One difference from the spike: a real call speaks several sentences in a row as they stream
/// in (`agent.speech`, one event per sentence), not one utterance at a time - `speak(_:)` queues
/// rather than replacing, so sentence 2 doesn't cut off sentence 1.
final class VoiceLoop: NSObject {
    /// `print()` never shows up in `log show`/the device's unified log once the app is
    /// backgrounded (which it is for the whole duration of a call) - confirmed by comparing a
    /// live `devicectl` console capture against a `log collect --device` covering the same
    /// window. `Logger` does, which is the only way to see what this class does mid-call.
    /// `nonisolated` + `Logger`'s own `Sendable` conformance let every closure here log
    /// directly, including the ones that must stay nonisolated (see `installTap` below).
    /// `static` (not an instance property) so `requestPermissions`, called before a `VoiceLoop`
    /// even exists, can use it too; accessed everywhere as `Self.logger`.
    private nonisolated static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "helix", category: "VoiceLoop")

    /// While muted the mic audio is dropped before it reaches the recognizer (the engine keeps
    /// running, so unmuting is instant). Driven by CallKit's mute action and the in-app button.
    var isMuted = false {
        didSet { audioInput.setMuted(isMuted) }
    }

    var onFinalUtterance: ((String) -> Void)?
    var onPartialUtterance: ((String) -> Void)?
    var bargeInEnabled = true
    /// True while actively speaking OR with more queued sentences waiting - distinct from
    /// `speaking` alone, which toggles false momentarily between queued sentences (synthesis has
    /// a gap between one utterance finishing and the next starting). Driving UI off `speaking`
    /// directly would flicker a call's "speaking"/"listening" phase mid-reply; this doesn't.
    private(set) var isBusy = false
    var onBusyChanged: ((Bool) -> Void)?
    /// `SFSpeechAudioBufferRecognitionRequest.contextualStrings` - names Apple's recognizer
    /// otherwise mishears (project names, "Astra", "Claude", ...). Set before `start()`; a
    /// mid-call change takes effect on the next recognition restart (~1/min, or after an
    /// utterance), not immediately - acceptable for hints that change only between calls.
    var contextualStrings: [String] = []

    /// Echo cancellation. Setting the session mode to `.voiceChat` is NOT enough: an
    /// `AVAudioEngine` tap only gets AEC if voice processing is enabled on the node.
    var voiceProcessingEnabled = true

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synth = AVSpeechSynthesizer()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioInput = RecognitionAudioInput()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition = RecognitionTurnState()
    private var lifecycleGeneration = 0
    private var silenceGeneration = 0
    private var task: SFSpeechRecognitionTask?
    /// Guards against a tight restart loop: if a task dies within `minimumTaskLifetime` of
    /// being created, restarting it immediately just creates another task that dies just as
    /// fast - confirmed live as an infinite ~20ms restart loop that never gave real speech a
    /// chance to be recognized again after the first utterance. A short backoff limits retries
    /// for genuine failures; task identity separately rejects stale completion callbacks.
    private var taskStartedAt: Date?
    private let minimumTaskLifetime: TimeInterval = 0.4
    private let restartBackoff: TimeInterval = 0.6
    private var pauseTimer: Timer?
    private var running = false
    private(set) var speaking = false

    // TTS-through-the-engine bookkeeping (see `speakOne` below for why).
    private var playerConnectedFormat: AVAudioFormat?
    private var speechGeneration = 0
    private var writeFinished = false
    private var outstandingBuffers = 0
    private var speechQueue: [String] = []

    /// Silence after the last partial result that counts as "end of utterance".
    private let endOfUtteranceDelay: TimeInterval = 1.0

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(routeChanged(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: Permissions

    /// Ask up front, before a call starts. Asking inside `didActivate` puts the system alerts
    /// behind the CallKit call screen, where they are easy to miss (found in the spike).
    static func requestPermissions(completion: (@Sendable () -> Void)? = nil) {
        SFSpeechRecognizer.requestAuthorization { @Sendable status in
            Self.logger.notice("speech permission \(name(status), privacy: .public)")
            AVAudioApplication.requestRecordPermission { @Sendable granted in
                Self.logger.notice("mic permission \(granted ? "granted" : "denied", privacy: .public)")
                DispatchQueue.main.async { completion?() }
            }
        }
    }

    private nonisolated static func name(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    // MARK: Lifecycle

    /// `onReady` fires once the engine is actually capturing - not just requested. Speaking
    /// before this (e.g. straight off `CXProviderDelegate.didActivate`) races CallKit's own
    /// hardware route switch: the render can start before the route has physically changed over
    /// and gets silently dropped. Intermittent, not every time - confirmed live in the spike.
    func start(onReady: (@Sendable () -> Void)? = nil) {
        // `@Sendable` on both completion closures matters, not just style: without it, Swift
        // infers them as MainActor-isolated (since they're written inside this MainActor-
        // isolated method), but SFSpeechRecognizer/AVAudioApplication actually invoke their
        // completion handlers on their own background queues - the runtime isolation check at
        // closure entry then traps with "BUG IN CLIENT OF LIBDISPATCH: Block was expected to
        // execute on queue [com.apple.main-thread]", confirmed as a live crash on device.
        guard !running else { return }
        lifecycleGeneration += 1
        let lifecycle = lifecycleGeneration
        SFSpeechRecognizer.requestAuthorization { @Sendable [weak self] status in
            guard status == .authorized else {
                Self.logger.notice("speech permission \(Self.name(status), privacy: .public)")
                return
            }
            AVAudioApplication.requestRecordPermission { @Sendable granted in
                guard granted else {
                    Self.logger.notice("mic permission denied")
                    return
                }
                DispatchQueue.main.async {
                    guard let self, self.lifecycleGeneration == lifecycle else { return }
                    self.beginListening(onReady: onReady)
                }
            }
        }
    }

    func stop() {
        running = false
        lifecycleGeneration += 1
        _ = retireRecognition()
        cancelSpeaking()
        speechQueue.removeAll()
        updateBusyState()
        // Unconditional: an engine that failed to start (or was stopped by the system, e.g. an
        // interruption while the phone is locked) can still hold the tap from a previous
        // attempt, and installing a second one on the same bus raises an uncatchable
        // NSException that kills the app. Removing a tap that is not there is harmless.
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        task = nil
        request = nil
    }

    // MARK: Speech recognition

    /// The audio route is still switching to the call when this first runs (worst when the phone
    /// is locked and the app was just woken by a VoIP push), so the mic can briefly report no
    /// usable format. Retry a few times rather than leave the call silent forever.
    private func beginListening(onReady: (@Sendable () -> Void)? = nil, attempt: Int = 0) {
        let lifecycle = lifecycleGeneration
        func retry(_ reason: String) {
            guard attempt < 12 else {
                Self.logger.error("giving up starting the mic: \(reason, privacy: .public)")
                return
            }
            Self.logger.notice("mic not ready (\(reason, privacy: .public)), retry \(attempt + 1)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, !self.running, self.lifecycleGeneration == lifecycle else { return }
                self.beginListening(onReady: onReady, attempt: attempt + 1)
            }
        }
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
            retry("recognizer unavailable")
            return
        }
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        guard AVAudioSession.sharedInstance().isInputAvailable else {
            retry("no input available")
            return
        }
        running = true
        Self.logger.notice("on-device recognition supported: \(recognizer.supportsOnDeviceRecognition)")
        startRecognitionTask()
        engine.attach(player) // harmless if already attached from a previous call

        // Must happen before the tap and before the engine starts; it can change the node's
        // format, so the format is read afterwards.
        if voiceProcessingEnabled {
            do {
                try input.setVoiceProcessingEnabled(true)
                try engine.outputNode.setVoiceProcessingEnabled(true)
                Self.logger.notice("voice processing (AEC) enabled")
            } catch {
                Self.logger.error("voice processing failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0, input.inputFormat(forBus: 0).sampleRate > 0 else {
            _ = retireRecognition()
            running = false
            retry("input format invalid (\(Int(format.sampleRate)) Hz)")
            return
        }
        // `format: nil` lets the node supply whatever its format is at the instant the tap is
        // created. Passing the format read a moment ago can disagree with the hardware if the
        // route changes in between, which raises an NSException (a hard crash on device).
        // Capture the synchronized input bridge, not actor-isolated VoiceLoop state.
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { @Sendable [audioInput] buffer, _ in
            audioInput.append(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
            Self.logger.notice("mic capturing @ \(Int(format.sampleRate)) Hz, \(format.channelCount)ch")
            // The engine running confirms OUR tap is live, not that CallKit's HAL route switch
            // has physically finished. A short settle delay before the first TTS is the cheap
            // fix (found + verified in the spike); if silence still happens after this, the
            // real fix is waiting for a routeChange notification instead.
            let lifecycle = lifecycleGeneration
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self, self.running, self.lifecycleGeneration == lifecycle else { return }
                onReady?()
            }
        } catch {
            Self.logger.error("engine start failed: \(error.localizedDescription, privacy: .public)")
            input.removeTap(onBus: 0)
            _ = retireRecognition()
            running = false
            retry("engine start failed")
        }
    }

    private func startRecognitionTask() {
        guard running, !recognition.active, let recognizer else { return }
        let generation = recognition.begin()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        if !contextualStrings.isEmpty { request.contextualStrings = contextualStrings }
        self.request = request
        audioInput.replace(with: request)

        // `@Sendable` + an explicit `Task { @MainActor in }` hop for the same reason as
        // `installTap` above: SFSpeechRecognizer invokes this off the main actor, and this
        // closure (unlike the tap's) touches enough isolated state that doing it all
        // synchronously at entry isn't an option - so it hops instead of going nonisolated.
        // Result frequency (a few times a second) makes the async hop's cost irrelevant, unlike
        // the audio tap's much hotter path.
        Self.logger.notice("startRecognitionTask: task \(generation) created")
        taskStartedAt = Date()
        task = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, error in
            // `SFSpeechRecognitionResult` isn't Sendable, so pull out just the (Sendable) values
            // this needs before hopping actors - passing the result object itself across would
            // be a compile-time data-race error, not just a style issue.
            let transcript = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let hadError = error != nil
            let errorDescription = (error != nil && !Self.isNormalEnd(error!)) ? error!.localizedDescription : nil
            // Logged unconditionally (not just when `errorDescription` survives the
            // isNormalEnd filter) - that filter hid exactly the code/domain needed to diagnose
            // the restart-loop bug above, by design treating it as unremarkable noise.
            if let error {
                let ns = error as NSError
                Self.logger.notice("recognitionTask error detail: domain=\(ns.domain, privacy: .public) code=\(ns.code)")
            }
            Self.logger.notice(
                "recognitionTask result: transcript=\(transcript ?? "<nil>", privacy: .public) isFinal=\(isFinal) hadError=\(hadError)"
            )
            Task { @MainActor in
                guard let self, self.running, self.recognition.accepts(generation) else {
                    Self.logger.notice("recognitionTask \(generation) callback ignored: retired task")
                    return
                }
                if let transcript {
                    self.recognition.update(transcript, for: generation)
                    self.onPartialUtterance?(transcript)
                    // Ignore stale results before they can interrupt TTS or arm a timer.
                    if self.bargeInEnabled, self.speaking, !transcript.isEmpty {
                        Self.logger.notice("barge-in -> stop TTS")
                        self.stopSpeakingAndClearQueue()
                    }
                }
                if let errorDescription {
                    Self.logger.error("recognition error: \(errorDescription, privacy: .public)")
                }
                if hadError || isFinal {
                    let lifetime = self.taskStartedAt.map { Date().timeIntervalSince($0) } ?? .infinity
                    let delay = hadError && lifetime < self.minimumTaskLifetime ? self.restartBackoff : 0
                    // Retire first, then deliver text. Ending/cancelling can still enqueue
                    // callbacks, but none can mutate the next task or erase its transcript.
                    self.completeRecognition(after: delay)
                } else if transcript != nil {
                    self.armPauseTimer(for: generation)
                }
            }
        }
    }

    /// `SFSpeechRecognizer` ends a task with an error even on a clean stop; those are noise, not
    /// a real failure (found in the spike).
    private nonisolated static func isNormalEnd(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == "kAFAssistantErrorDomain" && [216, 1110, 301].contains(ns.code)
    }

    /// Invalidates callbacks, timers and retries before touching the asynchronous Speech API.
    @discardableResult
    private func retireRecognition() -> String {
        let text = recognition.retire()
        silenceGeneration += 1
        pauseTimer?.invalidate()
        pauseTimer = nil
        audioInput.replace(with: nil)
        let oldRequest = request
        let oldTask = task
        request = nil
        task = nil
        taskStartedAt = nil
        oldRequest?.endAudio()
        oldTask?.cancel()
        return text
    }

    private func completeRecognition(after delay: TimeInterval = 0) {
        let text = retireRecognition()
        let retiredGeneration = recognition.generation
        if !text.isEmpty, !speaking {
            Self.logger.notice("final utterance: \(text, privacy: .public)")
            onFinalUtterance?(text)
        }
        guard running, recognition.canRestart(after: retiredGeneration) else { return }
        if delay > 0 {
            Self.logger.notice("recognition retry after \(delay)s")
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.running,
                      self.recognition.canRestart(after: retiredGeneration) else { return }
                self.startRecognitionTask()
            }
        } else {
            startRecognitionTask()
        }
    }

    /// Callback handling and timer management both run on MainActor. A revision also rejects
    /// a timer that fired before a newer partial result but is still waiting for its actor hop.
    private func armPauseTimer(for generation: Int) {
        pauseTimer?.invalidate()
        silenceGeneration += 1
        let silence = silenceGeneration
        pauseTimer = Timer.scheduledTimer(withTimeInterval: endOfUtteranceDelay,
                                         repeats: false) { @Sendable [weak self] _ in
            Task { @MainActor in
                guard let self, self.running, self.recognition.accepts(generation),
                      self.silenceGeneration == silence else { return }
                guard !self.recognition.text.isEmpty, !self.speaking else { return }
                self.completeRecognition()
            }
        }
    }

    // MARK: TTS
    //
    // Routed through `engine`/`player` rather than a plain `synth.speak()`. Measured on-device
    // in the spike: with voice processing (AEC) enabled on the engine's input/output nodes, a
    // separately-playing `AVSpeechSynthesizer` (even with `usesApplicationAudioSession = true`)
    // gives the AEC unit no reference signal for what is being played - the mic produced *zero*
    // partial results, real speech included, for the whole time TTS played. Rendering TTS into
    // the same graph (`AVSpeechSynthesizer.write` -> `AVAudioPlayerNode` -> the engine's mixer)
    // gives AEC that reference, and barge-in only works because of this.
    //
    // Queued, not replaced: a call speaks several sentences in a row as `agent.speech` events
    // stream in, and sentence 2 arriving should not cut off sentence 1 still playing.

    func speak(_ text: String, voiceIdentifier: String? = nil, rate: Float = AVSpeechUtteranceDefaultSpeechRate, pitch: Float = 1.0) {
        Self.logger.notice("speak queued (\(text.count) chars, engine running: \(self.engine.isRunning), loop running: \(self.running))")
        speechQueue.append(text)
        processQueueIfNeeded(voiceIdentifier: voiceIdentifier, rate: rate, pitch: pitch)
        updateBusyState()
    }

    // MARK: PC voice (audio generated on the PC, played through the same engine graph)

    private var pcOutstanding = 0
    /// True from the first `agent.speech` marked `engine: "pc"` until `agent.audio.end`: the PC
    /// voice is ~1.5x slower than real time, so a gap between sentences is not the end of the turn.
    private var pcAwaitingEnd = false

    func setPCTurnActive(_ active: Bool) {
        pcAwaitingEnd = active
        if !active { flushPCPending() }
        updateBusyState()
    }

    /// Jitter buffer: the PC voice sends ~0.33 s pieces. When nothing is queued, hold pieces until
    /// about 400 ms is collected (or a short timer / the end of the turn), then start playing;
    /// after that every piece is scheduled as it arrives. A dry buffer just resumes on the next
    /// piece - the node keeps running, there is no restart and no switch to Apple's voice.
    private var pcPending: [AVAudioPCMBuffer] = []
    private var pcPendingSeconds = 0.0
    private var pcFlushGeneration = 0
    private static let pcJitterSeconds = 0.4

    private func flushPCPending() {
        pcFlushGeneration += 1
        let buffers = pcPending
        pcPending.removeAll()
        pcPendingSeconds = 0
        for buffer in buffers { schedulePCBuffer(buffer) }
    }

    /// One sentence: mono signed 16-bit little-endian PCM.
    func playPCM(_ data: Data, sampleRate: Int) {
        let frames = data.count / 2
        guard frames > 0, sampleRate > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let out = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<frames { out[i] = Float(Int16(littleEndian: samples[i])) / 32768 }
        }
        if pcOutstanding > 0 && pcPending.isEmpty {
            schedulePCBuffer(buffer) // already playing: keep it gapless
            return
        }
        pcPending.append(buffer)
        pcPendingSeconds += Double(frames) / Double(sampleRate)
        updateBusyState()
        if pcPendingSeconds >= Self.pcJitterSeconds {
            flushPCPending()
        } else if pcPending.count == 1 {
            // A short sentence may never reach 400 ms: don't hold it more than a moment.
            pcFlushGeneration += 1
            let generation = pcFlushGeneration
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, self.pcFlushGeneration == generation else { return }
                self.flushPCPending()
            }
        }
    }

    /// A whole recorded clip (wav): the greeting, or what Helix says when it calls you.
    func playClip(_ wav: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("clip-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        guard (try? wav.write(to: url)) != nil,
              let file = try? AVAudioFile(forReading: url),
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buffer)) != nil, buffer.frameLength > 0 else {
            Self.logger.error("could not decode a clip (\(wav.count) bytes)")
            return
        }
        schedulePCBuffer(buffer)
    }

    private func schedulePCBuffer(_ buffer: AVAudioPCMBuffer) {
        guard engine.isRunning else {
            Self.logger.error("PC audio dropped: engine not running")
            return
        }
        ensurePlayerReady(format: buffer.format)
        pcOutstanding += 1
        updateBusyState()
        let generation = speechGeneration
        player.scheduleBuffer(buffer, completionCallbackType: .dataRendered) { @Sendable [weak self] _ in
            DispatchQueue.main.async {
                guard let self, generation == self.speechGeneration else { return }
                self.pcOutstanding = max(0, self.pcOutstanding - 1)
                self.updateBusyState()
            }
        }
    }

    /// Plays a raw mono buffer (the ringback tone) through the same player node as speech, so it
    /// takes the call's route. `completion` does not fire if playback is cancelled.
    func playTone(_ pcm: AVAudioPCMBuffer, completion: @escaping @Sendable () -> Void) {
        ensurePlayerReady(format: pcm.format)
        player.scheduleBuffer(pcm, completionCallbackType: .dataRendered) { @Sendable _ in
            DispatchQueue.main.async { completion() }
        }
    }

    func stopTone() {
        player.stop()
    }

    /// Barge-in, end-of-call, and an interrupt from the server (`agent.speech.end
    /// {cancelled:true}` / `route.interrupt`) all land here: drop whatever is still queued and
    /// stop anything already playing.
    func stopSpeakingAndClearQueue() {
        speechQueue.removeAll()
        cancelSpeaking()
        updateBusyState()
    }

    private func updateBusyState() {
        let busy = speaking || !speechQueue.isEmpty || pcOutstanding > 0 || pcAwaitingEnd || !pcPending.isEmpty
        guard busy != isBusy else { return }
        isBusy = busy
        onBusyChanged?(busy)
    }

    private func processQueueIfNeeded(voiceIdentifier: String?, rate: Float, pitch: Float) {
        guard !speaking, !speechQueue.isEmpty else { return }
        let text = speechQueue.removeFirst()
        speakOne(text, voiceIdentifier: voiceIdentifier, rate: rate, pitch: pitch) { [weak self] in
            Task { @MainActor in
                self?.processQueueIfNeeded(voiceIdentifier: voiceIdentifier, rate: rate, pitch: pitch)
            }
        }
    }

    private func speakOne(_ text: String, voiceIdentifier: String?, rate: Float, pitch: Float, completion: @escaping @Sendable () -> Void) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = rate
        utterance.pitchMultiplier = pitch
        if let voiceIdentifier { utterance.voice = AVSpeechSynthesisVoice(identifier: voiceIdentifier) }

        speechGeneration += 1
        let generation = speechGeneration
        writeFinished = false
        outstandingBuffers = 0
        speaking = true

        // `@Sendable` on both closures below for the same reason as `installTap`/
        // `recognitionTask` above: AVSpeechSynthesizer/AVAudioPlayerNode invoke these off the
        // main actor. The `DispatchQueue.main.async` hops already inside them were necessary
        // but not sufficient on their own - the entry-point isolation check traps before that
        // hop ever runs, so the closures themselves must be nonisolated too.
        synth.write(utterance) { @Sendable [weak self] buffer in
            guard let self, let pcm = buffer as? AVAudioPCMBuffer else { return }
            // AVAudioPCMBuffer isn't Sendable; Apple's completion contract hands over sole
            // ownership here though, so boxing it is a safe way to cross into the @MainActor
            // hop below without the compiler's region-isolation check misreading that handoff
            // as a race.
            let pcmBox = UncheckedSendableBox(value: pcm)
            DispatchQueue.main.async { [self] in
                let pcm = pcmBox.value
                guard generation == self.speechGeneration else { return } // cancelled/superseded
                if pcm.frameLength == 0 {
                    // Zero-length buffer marks "no more audio from the synthesizer", not
                    // "finished playing" - playback of what's queued continues.
                    self.writeFinished = true
                    self.finishIfIdle(generation: generation, completion: completion)
                    return
                }
                self.ensurePlayerReady(format: pcm.format)
                self.outstandingBuffers += 1
                self.player.scheduleBuffer(pcm, completionCallbackType: .dataRendered) { @Sendable [weak self] _ in
                    DispatchQueue.main.async {
                        guard let self, generation == self.speechGeneration else { return }
                        self.outstandingBuffers -= 1
                        self.finishIfIdle(generation: generation, completion: completion)
                    }
                }
            }
        }
    }

    private func finishIfIdle(generation: Int, completion: @escaping @Sendable () -> Void) {
        guard generation == speechGeneration, writeFinished, outstandingBuffers <= 0, speaking else { return }
        speaking = false
        updateBusyState()
        completion()
    }

    private func cancelSpeaking() {
        speechGeneration += 1
        player.stop()
        pcOutstanding = 0
        pcAwaitingEnd = false
        pcPending.removeAll()
        pcPendingSeconds = 0
        pcFlushGeneration += 1
        if speaking {
            speaking = false
        }
    }

    private func ensurePlayerReady(format: AVAudioFormat) {
        if playerConnectedFormat != format {
            engine.disconnectNodeOutput(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            playerConnectedFormat = format
        }
        if !player.isPlaying {
            player.play()
        }
    }

    // MARK: Route changes (speaker vs AirPods vs car)

    @objc private func routeChanged(_ note: Notification) {
        let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: raw) ?? .unknown
        Self.logger.notice("route change (\(Self.reasonName(reason), privacy: .public)): \(Self.routeDescription(), privacy: .public)")
    }

    static func routeDescription() -> String {
        let route = AVAudioSession.sharedInstance().currentRoute
        let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        let outputs = route.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        return "in[\(inputs)] out[\(outputs)]"
    }

    private static func reasonName(_ r: AVAudioSession.RouteChangeReason) -> String {
        switch r {
        case .newDeviceAvailable: return "new device"
        case .oldDeviceUnavailable: return "device gone"
        case .categoryChange: return "category change"
        case .override: return "override"
        case .wakeFromSleep: return "wake"
        case .noSuitableRouteForCategory: return "no route"
        case .routeConfigurationChange: return "reconfig"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }
}

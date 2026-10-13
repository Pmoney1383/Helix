import CarPlay
import Observation
import OSLog
import UIKit

/// CarPlay for the voice-based conversation category: one voice-control screen that follows the
/// call. Idle it offers Claude and Astra; during a call it shows what Helix is doing (connecting,
/// listening, speaking, muted, problem) with Mute and End. The call itself is the normal CallKit
/// call, so the car's audio route and steering-wheel buttons just work. See docs/CARPLAY.md.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private enum StateID {
        static let idle = "idle"
        static let connecting = "connecting"
        static let listening = "listening"
        static let speaking = "speaking"
        static let muted = "muted"
        static let problem = "problem"
    }

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "helix", category: "CarPlay")

    private var interfaceController: CPInterfaceController?
    private var template: CPVoiceControlTemplate?
    private var store: HelixStore { AppServices.store }
    private var observing = false

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        if #available(iOS 26.4, *) {
            Self.log.notice("connected: max button image \(CPButtonMaximumImageSize.width, privacy: .public)x\(CPButtonMaximumImageSize.height, privacy: .public), max buttons \(CPVoiceControlState.maximumActionButtonCount, privacy: .public), iOS \(ProcessInfo.processInfo.operatingSystemVersionString, privacy: .public)")
        }
        let template = CPVoiceControlTemplate(voiceControlStates: [
            state(StateID.idle, ["Call Claude or Astra", "Claude or Astra", "Helix"], symbol: "waveform", buttons: idleButtons()),
            state(StateID.connecting, ["Connecting…", "Connecting"], symbol: "waveform", buttons: callButtons()),
            state(StateID.listening, ["Listening", "Listening…"], symbol: "mic.fill", buttons: callButtons()),
            state(StateID.speaking, ["Speaking", "Helix is speaking"], symbol: "waveform", buttons: callButtons()),
            state(StateID.muted, ["Muted", "Mic muted"], symbol: "mic.slash.fill", buttons: callButtons()),
            state(StateID.problem, ["Connection lost", "Try again"], symbol: "exclamationmark.triangle.fill", buttons: idleButtons()),
        ])
        self.template = template
        interfaceController.setRootTemplate(template, animated: false, completion: nil)
        observing = true
        render()
        observe()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        observing = false
        self.interfaceController = nil
        template = nil
        // The car was unplugged mid-call: the phone keeps the call (it can be on the phone or an
        // AirPods route) and the user can end it there. Nothing to tear down here.
    }

    // MARK: Following the call

    private func observe() {
        guard observing else { return }
        withObservationTracking {
            _ = store.activeCall?.phase
            _ = store.activeCall == nil
            _ = store.isMuted
            _ = store.callError
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.render()
                self?.observe()
            }
        }
    }

    /// Switches state only; the template is built once and never rebuilt on status changes.
    private func render() {
        guard let template else { return }
        let id: String
        if let call = store.activeCall {
            if store.isMuted {
                id = StateID.muted
            } else {
                switch call.phase {
                case .connecting: id = StateID.connecting
                case .listening: id = StateID.listening
                case .speaking: id = StateID.speaking
                }
            }
        } else if store.callError != nil {
            id = StateID.problem
        } else {
            id = StateID.idle
        }
        if template.activeStateIdentifier != id {
            template.activateVoiceControlState(withIdentifier: id)
        }
    }

    // MARK: Building the states

    private func state(_ id: String, _ titles: [String], symbol: String, buttons: [CPButton]) -> CPVoiceControlState {
        let image = Self.indicator(symbol)
        let state: CPVoiceControlState
        if #available(iOS 27.0, *) {
            // A flat charcoal fill behind everything: no wallpaper, no gradient.
            state = CPVoiceControlState(identifier: id, titleVariants: titles, image: image, backgroundImage: Self.flat(Palette.background), repeats: false)
        } else {
            state = CPVoiceControlState(identifier: id, titleVariants: titles, image: image, repeats: false)
        }
        if #available(iOS 26.4, *) { state.actionButtons = buttons }
        return state
    }

    private func idleButtons() -> [CPButton] {
        [
            button("C", symbol: "phone.fill") { [weak self] in self?.start(.claude) },
            button("A", symbol: "phone.fill") { [weak self] in self?.start(.codex) },
        ]
    }

    private func callButtons() -> [CPButton] {
        [
            button("", symbol: "mic.slash.fill") { [weak self] in
                guard let self else { return }
                self.store.setMuted(!self.store.isMuted)
            },
            button("", symbol: "phone.down.fill") { [weak self] in self?.store.endCall() },
        ]
    }

    /// One tap starts a call; a second tap while one is starting or running does nothing
    /// (`startCall` refuses when a call exists), so repeated taps never create duplicate sessions.
    private func start(_ door: FrontDoor) {
        guard store.activeCall == nil else { return }
        store.startCall(door)
    }

    // MARK: Drawing

    private enum Palette {
        static let background = UIColor(red: 0x12 / 255, green: 0x12 / 255, blue: 0x12 / 255, alpha: 1)
        static let gold = UIColor(red: 0xF5 / 255, green: 0xB9 / 255, blue: 0x42 / 255, alpha: 1)
    }

    /// CarPlay shows a button's image only (a `title` is ignored on this template) and the image
    /// area is small, so the buttons are gold icons, with a one-letter monogram for Claude /
    /// Astra; the screen title spells out which is which. Both are drawn identically.
    private func button(_ title: String, symbol: String, action: @escaping @MainActor () -> Void) -> CPButton {
        let button = CPButton(image: Self.labelledImage(title, symbol: symbol), handler: Self.handler(action))
        button.title = title.isEmpty ? nil : title
        return button
    }

    /// CarPlay calls the handler on a background queue. With MainActor as the module default, a closure
    /// written inline here is MainActor-isolated and traps on that queue, so it is built nonisolated.
    private nonisolated static func handler(_ action: @escaping @MainActor () -> Void) -> @Sendable (CPButton) -> Void {
        { _ in Task { @MainActor in action() } }
    }

    /// Only the middle band of the square image survives the stretch into the pill, so everything
    /// is drawn small and centred: a gold ring with the phone inside, then the letter.
    private static func labelledImage(_ title: String, symbol: String) -> UIImage {
        let size = CPButtonMaximumImageSize
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { context in
            let unit = size.height
            let ringSide = unit * 0.40
            let letterAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: unit * 0.34, weight: .bold),
                .foregroundColor: Palette.gold,
            ]
            let text = title as NSString
            let textSize = text.size(withAttributes: letterAttributes)
            let gap = unit * 0.08
            let total = ringSide + (title.isEmpty ? 0 : gap + textSize.width)
            var x = max(0, (size.width - total) / 2)
            let ringRect = CGRect(x: x, y: (size.height - ringSide) / 2, width: ringSide, height: ringSide)
            Palette.gold.setStroke()
            let ring = UIBezierPath(ovalIn: ringRect.insetBy(dx: 0.7, dy: 0.7))
            ring.lineWidth = 1.4
            ring.stroke()
            let config = UIImage.SymbolConfiguration(pointSize: ringSide * 0.5, weight: .semibold)
            if let icon = UIImage(systemName: symbol, withConfiguration: config)?.withTintColor(Palette.gold, renderingMode: .alwaysOriginal) {
                icon.draw(at: CGPoint(x: ringRect.midX - icon.size.width / 2, y: ringRect.midY - icon.size.height / 2))
            }
            guard !title.isEmpty else { return }
            x += ringSide + gap
            text.draw(at: CGPoint(x: x, y: (size.height - textSize.height) / 2), withAttributes: letterAttributes)
        }
    }

    /// The central voice indicator: a gold ring with a gold symbol and a soft gold glow, like the
    /// design reference. CarPlay allows at most 150 x 150 pt for a state image.
    private static func indicator(_ symbol: String) -> UIImage {
        let side: CGFloat = 150
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { context in
            let cg = context.cgContext
            let ringRect = CGRect(x: 12, y: 12, width: side - 24, height: side - 24)
            cg.saveGState()
            cg.setShadow(offset: .zero, blur: 18, color: Palette.gold.withAlphaComponent(0.55).cgColor)
            Palette.gold.setStroke()
            let ring = UIBezierPath(ovalIn: ringRect)
            ring.lineWidth = 6
            ring.stroke()
            cg.restoreGState()
            let config = UIImage.SymbolConfiguration(pointSize: ringRect.width * 0.5, weight: .bold)
            guard let glyph = UIImage(systemName: symbol, withConfiguration: config)?
                .withTintColor(Palette.gold, renderingMode: .alwaysOriginal) else { return }
            glyph.draw(at: CGPoint(x: (side - glyph.size.width) / 2, y: (side - glyph.size.height) / 2))
        }
    }

    private static func flat(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
    }
}
